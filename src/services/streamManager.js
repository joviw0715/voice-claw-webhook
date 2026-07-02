import twilio from 'twilio';
import axios from 'axios';
import { decode as mulawDecode } from '../utils/mulaw.js';
import { getDefaultSttProvider, getSttProvider } from '../providers/stt/index.js';
import { getDefaultTtsProvider, getTtsProvider } from '../providers/tts/index.js';
import { getDefaultLlmProvider, getLlmProvider, streamWithFallback } from '../providers/llm/index.js';
import { classifyIntent } from './openClawLlm.js';
import { getContext, saveContext, getUserMemory, updateUserMemory } from './redisClient.js';
import { retrieveKnowledge } from './qdrantClient.js';
import { getNextAmbientMulawChunk } from '../utils/ambientMixer.js';
import { detectGender } from '../utils/genderDetect.js';

async function fetchHotlineKnowledge(hotlineId) {
  const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
  if (!consoleUrl || !hotlineId) {
    console.warn(`[knowledge] skipped — CONSOLE_CALLBACK_URL=${consoleUrl} hotlineId=${hotlineId}`);
    return '';
  }
  try {
    const token = process.env.CONSOLE_API_TOKEN || process.env.SESSION_SECRET || '';
    console.log(`[knowledge] fetching hotline=${hotlineId} url=${consoleUrl} token=${token ? 'set' : 'MISSING'}`);
    const { data } = await axios.get(`${consoleUrl}/api/hotlines/${hotlineId}/knowledge`, {
      timeout: 5000,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`[knowledge] empty response for hotline=${hotlineId} — data:`, JSON.stringify(data)?.slice(0, 200));
      return '';
    }
    console.log(`[knowledge] loaded ${data.length} articles for hotline=${hotlineId}`);
    return data.map(a => `## ${a.title}\n${a.content}`).join('\n\n');
  } catch (err) {
    console.warn(`[knowledge] fetch failed for hotline ${hotlineId}:`, err.message, err.response?.status);
    return '';
  }
}

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  '你係一個用廣東話嘅 AI 陪伴照護員，你的名字叫祖兒。如果 User memory 有用戶名字就用佢嘅名字稱呼佢；如果唔知名字，對話開始時先有禮貌地問佢點稱呼，然後一直用佢嘅名字。你係語音通話，唔係文字，所以：絕對禁止任何 markdown、bullet point、清單、表格、時間表、數字列表、標題；唔好長篇大論；每次只講一個意思、一句話。規則：全程廣東話，語速慢，句子短，一次一條問；安撫陪伴；唔好每句都叫用戶名字，自然地間中叫一次就夠；分享資訊時用口語講出來，唔好用清單格式；佢嘅問題如果你有背景資料，識答就用口語簡單答；絕對唔好糾正錯誤記憶，用重述或選項式問題；不確定或急症徵象引導搵真人幫手；End Call 前必須有禮貌地跟用戶說再見';

// Sentence delimiters — flush TTS on these boundaries for lower perceived latency
const SENTENCE_RE = /[。？！\n]/;

// Cantonese + English farewell phrases
const FAREWELL_RE = /拜拜|再見|掛線|掛電話|掰掰|goodbye|bye/i;

// Inbound escalation — caller requesting a human agent
const ESCALATION_RE = /唔好意思.*人工|人工.*服務|轉真人|真人.*服務|manager|supervisor|complaint|投訴/i;

// Callback scheduling — user asking to be called back after a delay
const CALLBACK_RE = /打返|打電話返|call.*back|callback/i;

function parseCallbackDelayMs(text) {
  const minMatch = text.match(/(\d+)\s*分鐘/);
  if (minMatch) return parseInt(minMatch[1]) * 60 * 1000;
  if (/半個鐘|半小時/.test(text)) return 30 * 60 * 1000;
  if (/一個鐘|1個鐘/.test(text)) return 60 * 60 * 1000;
  return 60 * 1000; // default 1 min if no time found
}

// Strip non-speakable characters before TTS: emoji, markdown formatting, name prefixes
function cleanForTts(text) {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F9FF}]/gu, '') // emoji
    .replace(/\*+/g, '')           // markdown bold/italic asterisks
    .replace(/#+\s*/g, '')          // markdown headers
    .replace(/[_~`]/g, '')          // other markdown
    .replace(/^\s*[-•]\s*/u, '')    // bullet/list prefixes (- or •)
    .replace(/^[一-鿿\w]+[：:]\s*/u, '') // LLM name prefix e.g. "祖兒："
    .trim();
}

// Returns true if text is predominantly English/non-Chinese — i.e. LLM chain-of-thought.
// Ratio-based: less than 40% Chinese characters = thinking. This catches English sentences
// that quote Chinese words (e.g. 'clarify what "攰" means').
function isThinkingText(text) {
  const clean = text.replace(/\s/g, '');
  if (!clean) return true;
  const chinese = (clean.match(/[一-鿿㐀-䶿]/g) || []).length;
  return chinese / clean.length < 0.40;
}

// If a thinking sentence has a Chinese suffix (model transitioning from thinking to answer),
// extract and return just the Chinese portion. Returns null if nothing worth speaking.
function extractChineseSuffix(text) {
  const m = text.match(/[一-鿿㐀-䶿，。？！、：；""（）【】…]{4,}.*/);
  if (!m) return null;
  const candidate = m[0].replace(/[A-Za-z0-9\s.,!?'"()[\]{}@#$%^&*_+=|\\/<>~`]+$/, '').trim();
  return candidate.length >= 4 ? candidate : null;
}

// Extract user's name from conversation history using common Cantonese/English self-introduction patterns.
// No LLM needed — these patterns are simple and reliable.
function extractNameFromHistory(history) {
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const t = msg.content;
    let m;
    if ((m = t.match(/我叫([阿小大老細]?[一-鿿]{1,4})/))) return m[1];
    if ((m = t.match(/我係([阿小大老細]?[一-鿿]{1,4})/))) return m[1];
    if ((m = t.match(/叫我([阿小大老細]?[一-鿿]{1,4})/))) return m[1];
    if ((m = t.match(/我姓([一-鿿]{1,2})/))) return m[1] + '先生/小姐';
    if ((m = t.match(/姓([一-鿿]{1,2})[嘅的]?[，,。\s]/))) return m[1] + '先生/小姐';
    if ((m = t.match(/my name is ([A-Za-z]+)/i))) return m[1];
    if ((m = t.match(/i'?m ([A-Za-z]+)/i))) return m[1];
  }
  return null;
}


const activeStreams = new Map(); // callSid → close()

// OpenClaw sometimes returns an error string instead of an AI reply
function isErrorResponse(text) {
  return text.startsWith('⚠') || text.startsWith('Error') || text.startsWith('error');
}

// Creates a handler for one Twilio Media Stream WebSocket connection.
// log(callSid, step, detail) — same logger signature as server.js
export function createCallHandler(ws, log) {
  let streamSid = null;
  let callSid = 'unknown';
  let phone = 'unknown';
  let contactId = null;
  let campaignId = null;
  let hotlineId = null;
  let direction = 'outbound';
  let afterHours = false;
  let voiceId = process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady';
  let paramGreetingText = '';
  let paramSystemPrompt = '';
  let hotlineKnowledge = '';
  let qdrantCollection = null;
  let callStartedAt = null;
  let stt = null;

  let state = 'IDLE';
  let cancelTts = null;
  let llmAborted = false;
  let ttsEndedAt = 0;
  let ttsLastChunkAt = 0;
  let ambientTimer = null; // continuous background audio loop
  let callerGender = 'unknown'; // detected from first utterance pitch analysis
  let firstUtterancePcm = []; // PCM chunks collected until first gender detection

  function startAmbientLoop() {
    if (ambientTimer) return;
    ambientTimer = setInterval(() => {
      if (state === 'IDLE' || ws.readyState !== ws.OPEN) return;
      // Stop ambient only when TTS is actively sending chunks — not just when state is SPEAKING.
      // This fills the gap between LLM start and first TTS chunk with continuous ambient.
      if (Date.now() - ttsLastChunkAt < 200) return;
      const chunk = getNextAmbientMulawChunk(160); // 20ms @ 8kHz μ-law
      if (chunk) sendAmbient(chunk);
    }, 20);
  }

  function close() {
    stt?.close();
    llmAborted = true;
    cancelTts?.();
    cancelTts = null;
    if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
    activeStreams.delete(callSid);
  }

  async function summarizeAndSaveMemory() {
    if (phone === 'unknown') return;
    try {
      const history = await getContext(callSid);
      if (history.length < 2) return;
      const name = extractNameFromHistory(history);
      if (!name) return;
      await updateUserMemory(phone, { name });
      log(callSid, '💾 MEMORY SAVED', `name=${name}`);
    } catch (err) {
      log(callSid, '⚠  MEMORY SAVE ERR', err.message);
    }
  }

  async function hangupCall() {
    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.calls(callSid).update({ status: 'completed' });
      log(callSid, '📵 HANGUP', 'call ended via REST API');
    } catch (err) {
      log(callSid, '⚠  HANGUP ERR', err.message);
    }
  }

  async function postCallReport() {
    const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
    if (!consoleUrl || !contactId || !campaignId) return;
    try {
      const history = await getContext(callSid);
      const transcript = history
        .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
        .join('\n');
      const duration_sec = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : null;
      await axios.post(`${consoleUrl}/api/webhooks/call-complete`, {
        call_sid: callSid,
        contact_id: parseInt(contactId),
        campaign_id: parseInt(campaignId),
        transcript,
        duration_sec,
      }, { timeout: 10000 });
      log(callSid, '📋 REPORT SENT', `contact=${contactId} campaign=${campaignId}`);
    } catch (err) {
      log(callSid, '⚠  REPORT ERR', err.message);
    }
  }

  async function postInboundCallReport() {
    const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
    if (!consoleUrl || !hotlineId) return;
    try {
      const history = await getContext(callSid);
      const transcript = history
        .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
        .join('\n');
      const duration_sec = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : null;
      await axios.post(`${consoleUrl}/api/webhooks/inbound/call-end`, {
        call_sid: callSid,
        transcript,
        duration_sec,
        escalated: false,
        after_hours: afterHours,
      }, { timeout: 10000 });
      log(callSid, '📋 INBOUND REPORT SENT', `hotline=${hotlineId}`);
    } catch (err) {
      log(callSid, '⚠  INBOUND REPORT ERR', err.message);
    }
  }

  // Providers resolved once per call — async because Redis config may override env defaults.
  // Resolution is fast (<50ms to Redis) so providers are always ready before any speech arrives.
  let _llmProvider = null;
  let _ttsProvider = null;
  let _sttProvider = null;
  const _providersReady = Promise.all([
    getDefaultLlmProvider(),
    getDefaultTtsProvider(),
    getDefaultSttProvider(),
  ]).then(([llm, tts, stt]) => {
    _llmProvider = llm; _ttsProvider = tts; _sttProvider = stt;
    console.log(`[providers] llm=${llm?.__name??'unknown'} tts=${tts?.__name??'unknown'} stt=${stt?.__name??'unknown'}`);
  }).catch(err => console.warn('[providers] resolution failed, using auto-detect:', err.message));

  // ── WebSocket helpers ────────────────────────────────────────────────────

  function sendMedia(audioBuffer) {
    if (ws.readyState !== ws.OPEN) return;
    ttsLastChunkAt = Date.now();
    ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: audioBuffer.toString('base64') },
    }));
  }

  // Send ambient audio without updating ttsLastChunkAt — ambient must not block STT echo suppression
  function sendAmbient(audioBuffer) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: audioBuffer.toString('base64') },
    }));
  }

  function sendClear() {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ event: 'clear', streamSid }));
  }

  // ── Interrupt ────────────────────────────────────────────────────────────

  function interrupt(reason) {
    if (state === 'SPEAKING' || state === 'THINKING') {
      log(callSid, '🔇 INTERRUPT', reason);
      sendClear();
      llmAborted = true;
      cancelTts?.();
      cancelTts = null;
      state = 'LISTENING';
    }
  }

  // ── STT ──────────────────────────────────────────────────────────────────

  // resetState=true on initial/normal start; false when restarting mid-turn
  // to avoid clobbering THINKING/SPEAKING state.
  function startListening(resetState = true) {
    if (resetState) state = 'LISTENING';
    const prevStt = stt;
    let thisStt;
    const sttProvider = _sttProvider ?? getSttProvider('azure');
    thisStt = sttProvider.createStream({
      onInterim(text) {
        if (stt !== thisStt) return; // superseded by a newer STT session
        if (Date.now() - ttsLastChunkAt < 1500) return; // TTS still playing — suppress echo
        if ((state === 'SPEAKING' || state === 'THINKING') && text.length >= 2) {
          interrupt(`user interim: "${text.slice(0, 30)}"`);
        }
      },
      onFinal(text) {
        if (stt !== thisStt) return; // superseded
        if (Date.now() - ttsLastChunkAt < 1500 || Date.now() - ttsEndedAt < 1500) {
          log(callSid, '🔇 ECHO SUPPRESSED', `"${text.slice(0, 30)}"`);
          return;
        }
        log(callSid, '👂 STT', `"${text}"`);
        if (state === 'LISTENING' && text.trim().length >= 2) {
          // Run gender detection on first utterance only (once per call)
          if (firstUtterancePcm !== null && firstUtterancePcm.length > 0) {
            const pcmBuffer = Buffer.concat(firstUtterancePcm);
            firstUtterancePcm = null;
            const result = detectGender(pcmBuffer);
            callerGender = result.gender;
            log(callSid, '🎙️  GENDER', `detected=${result.gender} hz=${result.hz} rms=${result.rms} corr=${result.corr} reason=${result.reason} (${pcmBuffer.length} bytes)`);
          }
          handleUserSpeech(text.trim());
        }
      },
      onError(err) {
        if (stt !== thisStt) return; // superseded
        log(callSid, '❌ STT ERROR', err.message);
        if (!llmAborted) {
          log(callSid, '🔄 STT RESTART (after error)');
          startListening(false); // preserve current state
        }
      },
      onSessionEnd(reason) {
        if (stt !== thisStt) return; // superseded — don't chain-restart
        log(callSid, '⚠  STT SESSION END', reason);
        if (!llmAborted) {
          log(callSid, '🔄 STT RESTART (after session end)');
          startListening(false); // preserve current state
        }
      },
    });
    stt = thisStt;
    // Close the previous session AFTER the new one is ready to avoid a gap
    if (prevStt) prevStt.close();
  }

  // ── Callback scheduling ──────────────────────────────────────────────────

  async function handleCallbackRequest(userText) {
    const delayMs = parseCallbackDelayMs(userText);
    const delayMin = Math.round(delayMs / 60000);
    log(callSid, '📅 CALLBACK SCHEDULED', `calling back ${phone} in ${delayMin}m`);

    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
    setTimeout(async () => {
      try {
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.calls.create({
          to: phone,
          from: process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER,
          url: `${baseUrl}/voice`,
        });
        log(callSid, '📞 CALLBACK FIRED', `called back ${phone}`);
      } catch (err) {
        log(callSid, '⚠  CALLBACK ERR', err.message);
      }
    }, delayMs);

    state = 'SPEAKING';
    const confirmText = `好，芬姐，${delayMin}分鐘後我打返畀你，拜拜！`;
    log(callSid, '🔊 CALLBACK CONFIRM', `"${confirmText}"`);
    await speakSentence(confirmText);
    ttsEndedAt = Date.now();
    state = 'LISTENING';
    await hangupCall();
  }

  // ── Main pipeline ────────────────────────────────────────────────────────

  async function handleUserSpeech(userText) {
    state = 'THINKING';
    llmAborted = false;

    // Escalation detection for inbound calls
    if (direction === 'inbound' && ESCALATION_RE.test(userText)) {
      const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
      if (consoleUrl) {
        log(callSid, '🚨 ESCALATION DETECTED', `"${userText.slice(0, 60)}"`);
        axios.post(`${consoleUrl}/api/webhooks/escalate`, { call_sid: callSid }, { timeout: 5000 })
          .catch((err) => log(callSid, '⚠  ESCALATE ERR', err.message));
      }
    }
    const t0 = Date.now();
    const userSaidFarewell = FAREWELL_RE.test(userText);

    // Short-circuit: callback scheduling is handled server-side via Twilio — no LLM needed
    if (CALLBACK_RE.test(userText)) {
      try {
        await handleCallbackRequest(userText);
      } catch (err) {
        log(callSid, '❌ CALLBACK ERROR', err.message);
        state = 'LISTENING';
      }
      return;
    }

    // Safety net: abort the turn after 90s to prevent permanent hangs
    // (e.g. OpenClaw SSE stream stalls after first response byte)
    const turnTimer = setTimeout(() => {
      if (state === 'THINKING' || state === 'SPEAKING') {
        log(callSid, '⏱  TURN TIMEOUT', 'aborting after 90s — LLM/TTS stall');
        llmAborted = true;
        cancelTts?.();
        cancelTts = null;
        state = 'LISTENING';
      }
    }, 90000);

    try {
      // Load context + RAG in parallel
      const [history, memory, intent, ragChunks] = await Promise.all([
        getContext(callSid),
        getUserMemory(phone),
        classifyIntent(userText),
        retrieveKnowledge(userText, 3, qdrantCollection),
      ]);
      log(callSid, '📚 CONTEXT', `history=${history.length} knowledge=${hotlineKnowledge.length > 0 ? 'yes' : 'none'} rag=${ragChunks.length} intent=${intent} (${Date.now() - t0}ms)`);

      if (llmAborted) return;

      const updatedHistory = [...history, { role: 'user', content: userText }].slice(-6);
      const knowledgeSection = hotlineKnowledge ? `\nKnowledge:\n${hotlineKnowledge}` : '';
      const ragSection = ragChunks.length > 0 ? `\nRelevant knowledge:\n${ragChunks.join('\n---\n')}` : '';
      const hkNow = new Intl.DateTimeFormat('zh-HK', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
      const genderHint = callerGender === 'female' ? '\n來電者聲音為女性，請用「小姐」稱呼。' : callerGender === 'male' ? '\n來電者聲音為男性，請用「先生」稱呼。' : '\n未能判斷來電者性別。第一次需要稱呼對方時，請問：「請問係先生定小姐？」，之後按回答用「先生」或「小姐」稱呼。';
      const systemPrompt = `${paramSystemPrompt || SYSTEM_PROMPT}\nUser memory: ${JSON.stringify(memory)}${knowledgeSection}${ragSection}\n現在香港時間：${hkNow}${genderHint}\n重要：唔好用「您好」、「你好」或任何問候語開始每次回覆——已經係通話中，直接答問題就好。每次只講一至兩句，唔好長篇大論。必須只用繁體中文（廣東話）回覆，唔好用英文。`;

      let fullReply = '';
      let sentenceBuf = '';
      let firstToken = true;
      let firstTts = true;

      const geminiDirect = process.env.USE_GEMINI_DIRECT === 'true';
      const useGemini = !!process.env.GEMINI_API_KEY && (geminiDirect || intent === 'chat');
      const useGroq = !!process.env.GROQ_API_KEY && !useGemini && (geminiDirect || intent === 'chat');
      const useOpenRouter = !!process.env.LLM_API_KEY && !useGemini && !useGroq && (geminiDirect || intent === 'chat');
      await _providersReady;
      const activeLlm = _llmProvider ?? getLlmProvider('openclaw');
      log(callSid, '🤖 LLM START', `${activeLlm.constructor?.name ?? 'provider'} (${Date.now() - t0}ms since user spoke)`);

      const messages = [{ role: 'system', content: systemPrompt }, ...updatedHistory];
      const llmStream = streamWithFallback(activeLlm, messages, phone);

      // For openclaw (tool queries): play an immediate Cantonese acknowledgment so the
      // user gets feedback during the long processing time instead of silence.
      // Only play filler when defaulting to openclaw and intent is tools.
      const isOpenClaw = !useGemini && !useGroq && !useOpenRouter && process.env.USE_CTM_LLM !== 'true';
      if (isOpenClaw && !llmAborted && intent === 'tools') {
        let filler = '好，等我幫你查下';
        if (/天氣|落雨|氣溫|溫度|晴天/.test(userText)) filler = '等我查下天氣先';
        else if (/幾點|時間|日期|星期/.test(userText)) filler = '等我睇下而家幾點';
        else if (/新聞|消息/.test(userText)) filler = '等我睇下最新消息先';
        sendClear();
        state = 'SPEAKING';
        firstTts = false;
        log(callSid, '🔊 TTS (filler)', `"${filler}"`);
        await speakSentence(filler);
      }

      for await (const tok of llmStream) {
        if (llmAborted) break;
        if (firstToken) {
          log(callSid, '🤖 LLM 1st TOKEN', `(${Date.now() - t0}ms)`);
          firstToken = false;
        }
        fullReply += tok;
        sentenceBuf += tok;

        if (SENTENCE_RE.test(sentenceBuf)) {
          const parts = sentenceBuf.split(SENTENCE_RE);
          sentenceBuf = parts.pop() ?? '';
          for (const part of parts) {
            const sentence = cleanForTts(part);
            if (sentence.length >= 2 && !llmAborted) {
              // Only filter thinking tokens for models that produce chain-of-thought (Gemini/Groq)
              if ((useGemini || useGroq) && isThinkingText(sentence)) {
                const chinese = extractChineseSuffix(sentence);
                if (chinese && !isThinkingText(chinese)) {
                  log(callSid, '🔕 EXTRACT FROM THINKING', `"${chinese.slice(0, 40)}"`);
                  // fall through with extracted Chinese portion
                  const extracted = chinese;
                  if (firstTts) { sendClear(); state = 'SPEAKING'; firstTts = false; }
                  log(callSid, '🔊 TTS', `"${extracted}"`);
                  await speakSentence(extracted);
                } else {
                  log(callSid, '🔕 SKIP THINKING', `"${sentence.slice(0, 40)}"`);
                }
                continue;
              }
              if (firstTts) {
                sendClear(); // flush buffered ambient so TTS plays immediately
                state = 'SPEAKING';
                firstTts = false;
              }
              log(callSid, '🔊 TTS', `"${sentence}"`);
              await speakSentence(sentence);
            }
          }
        }
      }

      // Flush remainder
      const tail = cleanForTts(sentenceBuf);
      if (tail.length >= 2 && !llmAborted && !((useGemini || useGroq) && isThinkingText(tail))) {
        if (firstTts) {
          sendClear();
          state = 'SPEAKING';
        }
        log(callSid, '🔊 TTS (tail)', `"${tail}"`);
        await speakSentence(tail);
      }

      if (!llmAborted) {
        const cleanReply = cleanForTts(fullReply);

        // OpenClaw sometimes returns an error string — don't save it or speak it
        if (isErrorResponse(cleanReply)) {
          log(callSid, '⚠  LLM ERROR RESPONSE', cleanReply.slice(0, 80));
          await speakSentence('唔好意思，我聽唔清楚，可以再講一次嗎？');
          state = 'LISTENING';
          return;
        }

        log(callSid, '✅ TURN DONE', `"${cleanReply.slice(0, 80).replace(/[\n\r]/g, '↵')}" (${Date.now() - t0}ms)`);
        const newHistory = [...updatedHistory, { role: 'assistant', content: cleanReply }];
        await saveContext(callSid, newHistory);
        ttsEndedAt = Date.now();
        state = 'LISTENING';

        // Push live transcript to console (fire-and-forget, inbound only)
        if (direction === 'inbound') {
          const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
          if (consoleUrl && callSid !== 'unknown') {
            const liveTranscript = newHistory
              .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
              .join('\n');
            axios.post(`${consoleUrl}/api/webhooks/inbound/transcript-update`, {
              call_sid: callSid,
              transcript: liveTranscript,
            }, { timeout: 3000 }).catch(() => {});
          }
        }
        // Save memory after each turn while name is still unknown — the name
        // exchange is the first thing captured and can be sliced out of history later
        if (!memory.name) summarizeAndSaveMemory();
        if (userSaidFarewell) {
          log(callSid, '👋 FAREWELL', 'waiting for audio to finish before hangup');
          // Delay so Twilio finishes playing the farewell audio before we disconnect
          await new Promise(r => setTimeout(r, 3000));
          await hangupCall();
        }
      }
    } catch (err) {
      log(callSid, '❌ PIPELINE ERROR', err.message);
      ttsEndedAt = Date.now();
      state = 'LISTENING';
    } finally {
      clearTimeout(turnTimer);
    }
  }

  function speakSentence(text) {
    return new Promise((resolve) => {
      const handle = (_ttsProvider ?? getTtsProvider('minimax')).synthesizeToStream(text, {
        voiceId,
        onChunk(buf) { if (!llmAborted) sendMedia(buf); },
        onDone() { clearTimeout(hangGuard); cancelTts = null; resolve(); },
        onError(err) { clearTimeout(hangGuard); log(callSid, '⚠  TTS ERR', err.message); cancelTts = null; resolve(); },
      });
      cancelTts = () => { clearTimeout(hangGuard); handle.cancel(); resolve(); };
      // Safety net: if MiniMax stream hangs with no response, resolve after 45s
      const hangGuard = setTimeout(() => {
        log(callSid, '⚠  TTS HANG', 'no response in 45s — aborting sentence');
        handle.cancel();
        cancelTts = null;
        resolve();
      }, 45000);
    });
  }

  // ── Public interface ─────────────────────────────────────────────────────

  return {
    onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        phone = msg.start.customParameters?.callerPhone || msg.start.customParameters?.phone || 'unknown';
        contactId = msg.start.customParameters?.contactId || null;
        campaignId = msg.start.customParameters?.campaignId || null;
        hotlineId = msg.start.customParameters?.hotlineId || null;
        direction = msg.start.customParameters?.direction || 'outbound';
        afterHours = msg.start.customParameters?.afterHours === 'true';
        voiceId = msg.start.customParameters?.voiceId || process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady';
        paramGreetingText = msg.start.customParameters?.greetingText || '';
        paramSystemPrompt = msg.start.customParameters?.systemPrompt || '';
        qdrantCollection = msg.start.customParameters?.qdrantCollection || null;

        // Pre-fetch hotline knowledge so it's ready for the first user turn
        if (hotlineId) {
          fetchHotlineKnowledge(hotlineId).then(k => { hotlineKnowledge = k; }).catch(() => {});
        }
        callStartedAt = Date.now();

        // If a prior handler exists for this call (Twilio reconnect), displace it
        const prevClose = activeStreams.get(callSid);
        if (prevClose) {
          prevClose();
          log(callSid, '🔄 DISPLACED old stream handler');
        }
        activeStreams.set(callSid, close);

        log(callSid, '🎙️  STREAM START', `from=${phone} direction=${direction}`);

        // Notify business-console for inbound calls
        if (direction === 'inbound' && hotlineId) {
          const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
          if (consoleUrl) {
            axios.post(`${consoleUrl}/api/webhooks/inbound/call-start`, {
              call_sid: callSid,
              hotline_id: parseInt(hotlineId),
              caller_phone: phone !== 'unknown' ? phone : null,
            }, { timeout: 5000 }).catch((err) =>
              log(callSid, '⚠  INBOUND START ERR', err.message),
            );
          }
        }

        startAmbientLoop();

        // For outbound calls the greeting is always known upfront — speak immediately
        // without waiting for getUserMemory to avoid silence at call start.
        if (direction === 'outbound') {
          let greetingText;
          if (paramGreetingText) {
            greetingText = paramGreetingText;
          } else if (paramSystemPrompt) {
            const firstSentence = paramSystemPrompt.split(/[。？！\n]/)[0].trim();
            greetingText = firstSentence.length >= 4 ? firstSentence : paramSystemPrompt.slice(0, 80).trim();
          } else {
            greetingText = process.env.FIRST_MESSAGE || '你好，請問係咪方便聽電話？';
          }
          state = 'SPEAKING';
          log(callSid, '🔊 GREETING', `"${greetingText}" voice=${voiceId}`);
          (_ttsProvider ?? getTtsProvider('minimax')).synthesizeToStream(greetingText, {
            voiceId,
            onChunk(buf) { sendMedia(buf); },
            onDone() {
              // Seed greeting as assistant turn so LLM doesn't repeat the opening
              saveContext(callSid, [{ role: 'assistant', content: greetingText }]).catch(() => {});
              startListening();
            },
            onError(err) {
              log(callSid, '⚠ GREETING ERR', `voice=${voiceId} err=${err.message}`);
              // Retry with default voice if the selected voice was rejected
              const fallbackVoice = process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady';
              if (voiceId !== fallbackVoice) {
                log(callSid, '🔊 GREETING RETRY', `falling back to voice=${fallbackVoice}`);
                (_ttsProvider ?? getTtsProvider('minimax')).synthesizeToStream(greetingText, {
                  voiceId: fallbackVoice,
                  onChunk(buf) { sendMedia(buf); },
                  onDone() {
                    saveContext(callSid, [{ role: 'assistant', content: greetingText }]).catch(() => {});
                    startListening();
                  },
                  onError(err2) { log(callSid, '⚠ GREETING FALLBACK ERR', err2.message); startListening(); },
                });
              } else {
                startListening();
              }
            },
          });
        } else {
          // Inbound: load user memory to personalise greeting with their name
          getUserMemory(phone).then(memory => {
            const name = memory?.name;
            const greetingText = paramGreetingText || (name
              ? `你好呀${name}，我係祖兒呀，你今日點呀？`
              : (process.env.FIRST_MESSAGE || '你好，我係祖兒呀，請問點稱呼你呀？'));
            state = 'SPEAKING';
            log(callSid, '🔊 GREETING', `"${greetingText}"`);
            (_ttsProvider ?? getTtsProvider('minimax')).synthesizeToStream(greetingText, {
              voiceId,
              onChunk(buf) { sendMedia(buf); },
              onDone() { startListening(); },
              onError(err) { log(callSid, '⚠ GREETING ERR', err.message); startListening(); },
            });
          }).catch(err => {
            log(callSid, '⚠ GREETING MEM ERR', err.message);
            const greetingText = paramGreetingText || process.env.FIRST_MESSAGE || '你好，我係祖兒呀，請問點稱呼你呀？';
            state = 'SPEAKING';
            (_ttsProvider ?? getTtsProvider('minimax')).synthesizeToStream(greetingText, {
              voiceId,
              onChunk(buf) { sendMedia(buf); },
              onDone() { startListening(); },
              onError(err2) { log(callSid, '⚠ GREETING ERR', err2.message); startListening(); },
            });
          });
        }
        return;
      }

      if (msg.event === 'media' && stt && state !== 'IDLE') {
        const mulaw = Buffer.from(msg.media.payload, 'base64');
        const pcm = mulawDecode(mulaw);
        stt.write(pcm);
        // Rolling buffer for gender detection — keep most recent 3s so we capture actual speech not pre-speech silence
        if (firstUtterancePcm !== null) {
          firstUtterancePcm.push(Buffer.from(pcm));
          let total = firstUtterancePcm.reduce((s, b) => s + b.length, 0);
          while (total > 48000 && firstUtterancePcm.length > 1) {
            total -= firstUtterancePcm.shift().length;
          }
        }
        return;
      }

      if (msg.event === 'stop') {
        log(callSid, '📵 STREAM STOP');
        summarizeAndSaveMemory(); // fire-and-forget
        if (direction === 'inbound') {
          postInboundCallReport(); // fire-and-forget
        } else {
          postCallReport();        // fire-and-forget
        }
        close();
      }
    },

    onClose(code, reason) {
      log(callSid, '🔌 WS CLOSE', `code=${code} reason=${reason || '(none)'} state=${state}`);
      close();
    },
  };
}
