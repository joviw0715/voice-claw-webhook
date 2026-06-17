// FreeSWITCH audio stream handler for /stream-fs WebSocket endpoint.
// Audio IN:  mod_audio_stream sends raw PCM16LE 8kHz binary frames
// Audio OUT: TTS mulaw chunks → .ulaw file in /audio → ESL uuid_broadcast to FreeSWITCH
//
// mod_audio_stream community edition is unidirectional (server→caller playback is commercial).
// Workaround: write TTS audio as a .ulaw file served over HTTP, then use FreeSWITCH ESL
// uuid_broadcast to play it back directly from the host.

import { createWriteStream, unlink } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createSttStream } from './streamingStt.js';
import { synthesizeToStream } from './streamingTts.js';
import { streamQueryGemini, streamQueryLLM } from './openClawLlm.js';
import { getContext, saveContext, getUserMemory } from './redisClient.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Connection: EslConnection } = require('modesl');

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, '../../audio');
const BASE_URL = (process.env.FS_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');

// ESL connection for uuid_broadcast — lazy-connect when needed
async function eslBroadcast(fsUuid, fileUrl) {
  const eslHost = process.env.FS_ESL_HOST || '127.0.0.1';
  const eslPort = parseInt(process.env.FS_ESL_PORT || '8021');
  const eslPass = process.env.FS_ESL_PASSWORD || 'CHANGEME_ESL_PASS';

  return new Promise((resolve, reject) => {
    const conn = new EslConnection(eslHost, eslPort, eslPass, () => {
      conn.api('uuid_broadcast', `${fsUuid} ${fileUrl} aleg`, () => {
        conn.disconnect();
        resolve();
      });
    });
    conn.on('error', (err) => reject(new Error(`ESL error: ${err.message}`)));
    setTimeout(() => reject(new Error('ESL timeout')), 5000);
  });
}

// Write mulaw chunks to a temp .ulaw file, return the filename
function writeMulawFile(mulawChunks, filename) {
  return new Promise((resolve, reject) => {
    const filePath = join(AUDIO_DIR, filename);
    const ws = createWriteStream(filePath);
    for (const chunk of mulawChunks) ws.write(chunk);
    ws.end();
    ws.on('finish', () => resolve(filePath));
    ws.on('error', reject);
  });
}

let fileSeq = 0;

export function createFsCallHandler(ws, req, log) {
  const url = new URL(req.url, 'http://localhost');
  const direction    = url.searchParams.get('direction') || 'inbound';
  const voiceId      = url.searchParams.get('voiceId') || process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady';
  const greetingText = url.searchParams.get('greetingText') || '';
  const systemPrompt = url.searchParams.get('systemPrompt') || '';
  const callerPhone  = url.searchParams.get('phone') || 'unknown';

  let callSid   = `fs-${Date.now()}`;
  let fsUuid    = url.searchParams.get('uuid') || null; // passed from dialplan ${uuid}
  let phone     = callerPhone;
  let stt       = null;
  let state     = 'IDLE';
  let ttsLastAt = 0;
  let llmAborted = false;

  // If uuid was passed in query string, update callSid immediately
  if (fsUuid) callSid = `fs-${fsUuid}`;

  async function playTts(text, { onDone, onError } = {}) {
    if (!fsUuid) {
      log(callSid, '⚠ NO UUID YET — buffering TTS');
    }
    const chunks = [];
    await new Promise((resolve) => {
      synthesizeToStream(text, {
        voiceId,
        onChunk(buf) { chunks.push(buf); },
        onDone() { resolve(); },
        onError(err) { log(callSid, '⚠ TTS ERR', err.message); resolve(); },
      });
    });

    if (!chunks.length || !fsUuid) {
      onDone?.();
      return;
    }

    ttsLastAt = Date.now();
    const seq = ++fileSeq;
    const filename = `fs-${callSid}-${seq}.ulaw`;
    try {
      await writeMulawFile(chunks, filename);
      const fileUrl = `${BASE_URL}/audio/${filename}`;
      log(callSid, '🔊 ESL PLAY', fileUrl);
      await eslBroadcast(fsUuid, fileUrl);
    } catch (err) {
      log(callSid, '⚠ ESL ERR', err.message);
    }

    // Clean up temp file after 30s (enough time for playback)
    setTimeout(() => {
      unlink(join(AUDIO_DIR, filename), () => {});
    }, 30000);

    onDone?.();
  }

  function interrupt(reason) {
    if (state === 'SPEAKING' || state === 'THINKING') {
      log(callSid, '🔇 INTERRUPT', reason);
      llmAborted = true;
      state = 'LISTENING';
    }
  }

  function startListening() {
    state = 'LISTENING';
    stt = createSttStream({
      onInterim(text) {
        if (Date.now() - ttsLastAt < 1500) return;
        if ((state === 'SPEAKING' || state === 'THINKING') && text.length >= 2) {
          interrupt(`user interim: "${text.slice(0, 30)}"`);
        }
      },
      onFinal(text) {
        if (Date.now() - ttsLastAt < 1500) {
          log(callSid, '🔇 ECHO SUPPRESSED', `"${text.slice(0, 30)}"`);
          return;
        }
        log(callSid, '👂 STT', `"${text}"`);
        if (state === 'LISTENING' && text.trim().length >= 2) {
          handleUserSpeech(text);
        }
      },
      onError(err) {
        log(callSid, '⚠ STT ERR', err.message);
        stt = null;
        startListening();
      },
    });
  }

  async function handleUserSpeech(text) {
    state = 'THINKING';
    llmAborted = false;
    log(callSid, '💭 THINKING', `"${text.slice(0, 60)}"`);

    const sysPrompt = systemPrompt || process.env.SYSTEM_PROMPT || '';
    let history = [];
    try { history = await getContext(callSid); } catch {}

    const messages = [
      { role: 'system', content: sysPrompt },
      ...history,
      { role: 'user', content: text },
    ];

    let reply = '';
    let ttsBuffer = '';
    state = 'SPEAKING';

    const geminiDirect = process.env.USE_GEMINI_DIRECT === 'true';
    const llmStream = geminiDirect ? streamQueryGemini(messages) : streamQueryLLM(messages, phone);

    try {
      for await (const token of llmStream) {
        if (llmAborted) break;
        reply += token;
        ttsBuffer += token;

        if (/[。？！\n]/.test(ttsBuffer)) {
          const chunk = ttsBuffer.trim();
          ttsBuffer = '';
          if (chunk) await playTts(chunk);
          if (llmAborted) break;
        }
      }
      if (ttsBuffer.trim() && !llmAborted) {
        await playTts(ttsBuffer.trim());
      }
    } catch (err) {
      log(callSid, '⚠ LLM ERR', err.message);
    }

    if (!llmAborted && reply) {
      try {
        await saveContext(callSid, [
          ...history,
          { role: 'user', content: text },
          { role: 'assistant', content: reply },
        ]);
      } catch {}
    }

    if (!llmAborted) startListening();
  }

  function speakGreeting(text) {
    state = 'SPEAKING';
    log(callSid, '🔊 FS GREETING', `"${text}" voice=${voiceId}`);
    playTts(text).then(() => {
      saveContext(callSid, [{ role: 'assistant', content: text }]).catch(() => {});
      startListening();
    }).catch((err) => {
      log(callSid, '⚠ GREETING ERR', err.message);
      startListening();
    });
  }

  // ── Start the session ────────────────────────────────────────────────────

  log(callSid, '🎙️ FS STREAM OPEN', `direction=${direction} voice=${voiceId} uuid=${fsUuid}`);

  // Start greeting immediately (uuid is passed via query param from dialplan)
  if (direction === 'inbound') {
    getUserMemory(phone).then(memory => {
      const name = memory?.name;
      const text = greetingText || (name
        ? `你好呀${name}，我係祖兒，你今日點呀？`
        : (process.env.FIRST_MESSAGE || '你好，我係祖兒，請問點稱呼你呀？'));
      speakGreeting(text);
    }).catch(() => {
      speakGreeting(greetingText || process.env.FIRST_MESSAGE || '你好，我係祖兒，請問點稱呼你呀？');
    });
  } else {
    speakGreeting(greetingText || process.env.FIRST_MESSAGE || '你好，請問係咪方便聽電話？');
  }

  // ── Public interface ─────────────────────────────────────────────────────

  return {
    onMessage(data, isBinary) {
      if (!isBinary) {
        try {
          const meta = JSON.parse(data.toString());
          if (meta.uuid && !fsUuid) {
            fsUuid = meta.uuid;
            callSid = `fs-${meta.uuid}`;
            log(callSid, '📋 FS META', `uuid=${meta.uuid}`);
          }
        } catch {}
        return;
      }

      if (stt && state !== 'IDLE') {
        stt.write(data);
      }
    },

    onClose(code, reason) {
      log(callSid, '📵 FS CLOSE', `code=${code} reason=${reason}`);
      stt?.end?.();
      stt = null;
    },
  };
}
