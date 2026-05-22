import { decode as mulawDecode } from '../utils/mulaw.js';
import { createSttStream } from './streamingStt.js';
import { synthesizeToStream } from './streamingTts.js';
import { streamQueryLLM } from './openClawLlm.js';
import { getContext, saveContext, getUserMemory } from './redisClient.js';
import { retrieveKnowledge } from './qdrantClient.js';

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  '你係一個用廣東話嘅 AI 陪伴照護員，你的名字叫祖兒，專門打電話關心芬姐。你已經有芬姐嘅詳細背景資料（內部文件），請只用作對話判斷，唔好讀出、唔好提及來源。規則：- 全程廣東話，語速慢，句子短，一次一條問- 安撫陪伴- 佢嘅問題如果你有背景資料, 識答就答- 絕對唔好糾正錯誤記憶；用重述、選項式問題- 不確定或急症徵象：引導搵真人幫手- End Call 前必須要有禮貌地跟芬姐說再見';

// Sentence delimiters — flush TTS on these boundaries for lower perceived latency
const SENTENCE_RE = /[。？！\n]/;

// Strip non-speakable characters before TTS: emoji, markdown formatting, name prefixes
function cleanForTts(text) {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F9FF}]/gu, '') // emoji
    .replace(/\*+/g, '')           // markdown bold/italic asterisks
    .replace(/#+\s*/g, '')          // markdown headers
    .replace(/[_~`]/g, '')          // other markdown
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

  // IDLE → LISTENING → THINKING → SPEAKING → LISTENING …
  let state = 'IDLE';
  let cancelTts = null;
  let llmAborted = false;

  function close() {
    stt?.close();
    llmAborted = true;
    cancelTts?.();
    cancelTts = null;
    activeStreams.delete(callSid);
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
    stt = createSttStream({
      onInterim(text) {
        // User started speaking while AI is active — interrupt
        if ((state === 'SPEAKING' || state === 'THINKING') && text.length >= 2) {
          interrupt(`user interim: "${text.slice(0, 30)}"`);
        }
      },
      onFinal(text) {
        log(callSid, '👂 STT', `"${text}"`);
        if (state === 'LISTENING' && text.trim().length >= 2) {
          handleUserSpeech(text.trim());
        }
      },
      onError(err) {
        log(callSid, '❌ STT ERROR', err.message);
        if (!llmAborted) {
          log(callSid, '🔄 STT RESTART (after error)');
          startListening(false); // preserve current state
        }
      },
      onSessionEnd(reason) {
        log(callSid, '⚠  STT SESSION END', reason);
        if (!llmAborted) {
          log(callSid, '🔄 STT RESTART (after session end)');
          startListening(false); // preserve current state
        }
      },
    });
  }

  // ── Main pipeline ────────────────────────────────────────────────────────

  async function handleUserSpeech(userText) {
    state = 'THINKING';
    llmAborted = false;
    const t0 = Date.now();

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
      const [history, memory, knowledge] = await Promise.all([
        getContext(callSid),
        getUserMemory(phone),
        retrieveKnowledge(userText),
      ]);
      log(callSid, '📚 CONTEXT', `history=${history.length} knowledge=${knowledge.length} (${Date.now() - t0}ms)`);

      if (llmAborted) return;

      const updatedHistory = [...history, { role: 'user', content: userText }].slice(-10);
      const systemPrompt = `${SYSTEM_PROMPT}\nUser memory: ${JSON.stringify(memory)}\nKnowledge: ${knowledge.join('\n')}`;

      state = 'SPEAKING';
      let fullReply = '';
      let sentenceBuf = '';
      let firstToken = true;

      log(callSid, '🤖 LLM START', `(${Date.now() - t0}ms since user spoke)`);

      const llmStream = streamQueryLLM([
        { role: 'system', content: systemPrompt },
        ...updatedHistory,
      ], phone);

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

        log(callSid, '✅ TURN DONE', `"${cleanReply.slice(0, 80)}" (${Date.now() - t0}ms)`);
        await saveContext(callSid, [
          ...updatedHistory,
          { role: 'assistant', content: cleanReply },
        ]);
        state = 'LISTENING';
      }
    } catch (err) {
      log(callSid, '❌ PIPELINE ERROR', err.message);
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
