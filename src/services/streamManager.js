import twilio from 'twilio';
import { decode as mulawDecode } from '../utils/mulaw.js';
import { createSttStream } from './streamingStt.js';
import { synthesizeToStream } from './streamingTts.js';
import { streamQueryLLM, streamQueryOpenRouter, classifyIntent } from './openClawLlm.js';
import { getContext, saveContext, getUserMemory, updateUserMemory } from './redisClient.js';
import { retrieveKnowledge } from './qdrantClient.js';
import { getNextAmbientMulawChunk } from '../utils/ambientMixer.js';

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  '你係一個用廣東話嘅 AI 陪伴照護員，你的名字叫祖兒。如果 User memory 有用戶名字就用佢嘅名字稱呼佢；如果唔知名字，對話開始時先有禮貌地問佢點稱呼，然後一直用佢嘅名字。你係語音通話，唔係文字，所以：絕對禁止任何 markdown、bullet point、清單、表格、時間表、數字列表、標題；唔好長篇大論；每次只講一個意思、一句話。規則：全程廣東話，語速慢，句子短，一次一條問；安撫陪伴；佢嘅問題如果你有背景資料，識答就用口語簡單答；絕對唔好糾正錯誤記憶，用重述或選項式問題；不確定或急症徵象引導搵真人幫手；End Call 前必須有禮貌地跟用戶說再見';

// Sentence delimiters — flush TTS on these boundaries for lower perceived latency
const SENTENCE_RE = /[。？！\n]/;

// Cantonese + English farewell phrases
const FAREWELL_RE = /拜拜|再見|掛線|掛電話|掰掰|goodbye|bye/i;

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
  let stt = null;

  let state = 'IDLE';
  let cancelTts = null;
  let llmAborted = false;
  let ttsEndedAt = 0;
  let ttsLastChunkAt = 0;
  let ambientTimer = null; // continuous background audio loop

  function startAmbientLoop() {
    if (ambientTimer) return;
    ambientTimer = setInterval(() => {
      // Only send ambient during silence — TTS sends its own mixed chunks when speaking
      if (state === 'SPEAKING' || state === 'IDLE' || ws.readyState !== ws.OPEN) return;
      const chunk = getNextAmbientMulawChunk(160); // 20ms @ 8kHz μ-law
      if (chunk) sendMedia(chunk);
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

  async function* openRouterWithFallback(messages, phone) {
    try {
      for await (const tok of streamQueryOpenRouter(messages)) {
        yield tok;
      }
    } catch (err) {
      log(callSid, '⚠  OpenRouter failed, falling back to OpenClaw', err.message);
      for await (const tok of streamQueryLLM(messages, phone)) {
        yield tok;
      }
    }
  }

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
    thisStt = createSttStream({
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
      const [history, memory, knowledge, intent] = await Promise.all([
        getContext(callSid),
        getUserMemory(phone),
        retrieveKnowledge(userText),
        classifyIntent(userText),
      ]);
      log(callSid, '📚 CONTEXT', `history=${history.length} knowledge=${knowledge.length} intent=${intent} (${Date.now() - t0}ms)`);

      if (llmAborted) return;

      const updatedHistory = [...history, { role: 'user', content: userText }].slice(-6);
      const systemPrompt = `${SYSTEM_PROMPT}\nUser memory: ${JSON.stringify(memory)}\nKnowledge: ${knowledge.join('\n')}`;

      state = 'SPEAKING';
      let fullReply = '';
      let sentenceBuf = '';
      let firstToken = true;

      const useOpenRouter = !!process.env.LLM_API_KEY && intent === 'chat';
      log(callSid, '🤖 LLM START', `${useOpenRouter ? 'OpenRouter' : 'OpenClaw'} (${Date.now() - t0}ms since user spoke)`);

      const messages = [{ role: 'system', content: systemPrompt }, ...updatedHistory];
      const llmStream = useOpenRouter
        ? openRouterWithFallback(messages, phone)
        : streamQueryLLM(messages, phone);

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
              log(callSid, '🔊 TTS', `"${sentence}"`);
              await speakSentence(sentence);
            }
          }
        }
      }

      // Flush remainder
      const tail = cleanForTts(sentenceBuf);
      if (tail.length >= 2 && !llmAborted) {
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
        await saveContext(callSid, [
          ...updatedHistory,
          { role: 'assistant', content: cleanReply },
        ]);
        ttsEndedAt = Date.now();
        state = 'LISTENING';
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
      const handle = synthesizeToStream(text, {
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
        phone = msg.start.customParameters?.phone || 'unknown';

        // If a prior handler exists for this call (Twilio reconnect), displace it
        const prevClose = activeStreams.get(callSid);
        if (prevClose) {
          prevClose();
          log(callSid, '🔄 DISPLACED old stream handler');
        }
        activeStreams.set(callSid, close);

        log(callSid, '🎙️  STREAM START', `from=${phone}`);
        startAmbientLoop();

        // Load user memory to personalise greeting, then play it.
        // Known user → greet by name. Unknown user → ask for their name.
        getUserMemory(phone).then(memory => {
          const name = memory?.name;
          const greetingText = name
            ? `你好呀${name}，我係祖兒呀，你今日點呀？`
            : (process.env.FIRST_MESSAGE || '你好，我係祖兒呀，請問點稱呼你呀？');
          state = 'SPEAKING';
          log(callSid, '🔊 GREETING', `"${greetingText}"`);
          synthesizeToStream(greetingText, {
            onChunk(buf) { sendMedia(buf); },
            onDone() { startListening(); },
            onError(err) { log(callSid, '⚠ GREETING ERR', err.message); startListening(); },
          });
        }).catch(err => {
          log(callSid, '⚠ GREETING MEM ERR', err.message);
          const greetingText = process.env.FIRST_MESSAGE || '你好，我係祖兒呀，請問點稱呼你呀？';
          state = 'SPEAKING';
          synthesizeToStream(greetingText, {
            onChunk(buf) { sendMedia(buf); },
            onDone() { startListening(); },
            onError(err2) { log(callSid, '⚠ GREETING ERR', err2.message); startListening(); },
          });
        });
        return;
      }

      if (msg.event === 'media' && stt && state !== 'IDLE') {
        const mulaw = Buffer.from(msg.media.payload, 'base64');
        stt.write(mulawDecode(mulaw));
        return;
      }

      if (msg.event === 'stop') {
        log(callSid, '📵 STREAM STOP');
        summarizeAndSaveMemory(); // fire-and-forget
        close();
      }
    },

    onClose(code, reason) {
      log(callSid, '🔌 WS CLOSE', `code=${code} reason=${reason || '(none)'} state=${state}`);
      close();
    },
  };
}
