import twilio from 'twilio';
import { decode as mulawDecode } from '../utils/mulaw.js';
import { createSttStream } from './streamingStt.js';
import { synthesizeToStream } from './streamingTts.js';
import { streamQueryLLM, streamQueryOpenRouter, classifyIntent } from './openClawLlm.js';
import { getContext, saveContext, getUserMemory } from './redisClient.js';
import { retrieveKnowledge } from './qdrantClient.js';

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  '你係一個用廣東話嘅 AI 陪伴照護員，你的名字叫祖兒，專門打電話關心芬姐。你已經有芬姐嘅詳細背景資料（內部文件），請只用作對話判斷，唔好讀出、唔好提及來源。你係語音通話，唔係文字，所以：絕對禁止任何 markdown、bullet point、清單、表格、時間表、數字列表、標題；唔好長篇大論；每次只講一個意思、一句話。規則：全程廣東話，語速慢，句子短，一次一條問；安撫陪伴；佢嘅問題如果你有背景資料，識答就用口語簡單答；絕對唔好糾正錯誤記憶，用重述或選項式問題；不確定或急症徵象引導搵真人幫手；End Call 前必須有禮貌地跟芬姐說再見';

// Sentence delimiters — flush TTS on these boundaries for lower perceived latency
const SENTENCE_RE = /[。？！\n]/;

// Cantonese + English farewell phrases
const FAREWELL_RE = /拜拜|再見|掛線|掛電話|掰掰|goodbye|bye/i;

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

// Track active stream handlers per callSid so reconnects displace the old handler
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
  let ttsEndedAt = 0; // timestamp when last AI speech finished (for echo suppression)

  function close() {
    stt?.close();
    llmAborted = true;
    cancelTts?.();
    cancelTts = null;
    activeStreams.delete(callSid);
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
        if ((state === 'SPEAKING' || state === 'THINKING') && text.length >= 2) {
          interrupt(`user interim: "${text.slice(0, 30)}"`);
        }
      },
      onFinal(text) {
        if (stt !== thisStt) return; // superseded
        if (Date.now() - ttsEndedAt < 1000) {
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

  // ── Main pipeline ────────────────────────────────────────────────────────

  async function handleUserSpeech(userText) {
    state = 'THINKING';
    llmAborted = false;
    const t0 = Date.now();
    const userSaidFarewell = FAREWELL_RE.test(userText);

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
        if (userSaidFarewell) {
          log(callSid, '👋 FAREWELL', 'user said goodbye — hanging up');
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

        // Play greeting through the stream, then start listening.
        // Doing this server-side means the greeting always plays exactly once
        // when the stream actually connects, regardless of how many TwiML retries occurred.
        const greetingText = process.env.FIRST_MESSAGE || '你好呀芬姐, 我係祖兒呀, 你今日點呀?';
        state = 'SPEAKING';
        log(callSid, '🔊 GREETING', `"${greetingText}"`);
        synthesizeToStream(greetingText, {
          onChunk(buf) { sendMedia(buf); },
          onDone() { startListening(); },
          onError(err) { log(callSid, '⚠ GREETING ERR', err.message); startListening(); },
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
        close();
      }
    },

    onClose(code, reason) {
      log(callSid, '🔌 WS CLOSE', `code=${code} reason=${reason || '(none)'} state=${state}`);
      close();
    },
  };
}
