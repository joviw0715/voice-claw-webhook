// FreeSWITCH audio stream handler for /stream-fs WebSocket endpoint.
// Audio IN:  mod_audio_stream sends raw PCM16LE 8kHz binary frames
// Audio OUT: TTS mulaw chunks → .ulaw file in /audio → ESL uuid_broadcast to FreeSWITCH
//
// mod_audio_stream community edition is unidirectional (server→caller playback is commercial).
// Workaround: write TTS audio as a .ulaw file served over HTTP, then use FreeSWITCH ESL
// uuid_broadcast to play it back directly from the host.

import { createWriteStream, unlink } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { decode as mulawDecode } from '../utils/mulaw.js';
import { getLlmProvider, getDefaultLlmProvider } from '../providers/llm/index.js';
import { getTtsProvider, getDefaultTtsProvider } from '../providers/tts/index.js';
import { getSttProvider, getDefaultSttProvider } from '../providers/stt/index.js';
import { getContext, saveContext, getUserMemory } from './redisClient.js';
import modesl from 'modesl';
const { Connection: EslConnection } = modesl;

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, '../../audio');
const BASE_URL = (process.env.FS_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');

console.log('[fs-stream] AUDIO_DIR:', AUDIO_DIR, 'BASE_URL:', BASE_URL);

// ESL connection for uuid_broadcast — lazy-connect when needed
// Validate that a UUID is a valid FreeSWITCH UUID (hex chars and hyphens only)
function isValidUuid(uuid) {
  return typeof uuid === 'string' && /^[0-9a-f-]{1,64}$/i.test(uuid);
}

// Shell-safe validator for env-var values that flow into ESL system/curl commands.
// Allows only URL-safe and path chars; rejects shell metacharacters.
function isShellSafe(str) {
  return typeof str === 'string' && /^[A-Za-z0-9_./:@%?=&+-]*$/.test(str);
}

async function eslBroadcast(fsUuid, fileUrl) {
  const eslHost = process.env.FS_ESL_HOST || '127.0.0.1';
  const eslPort = parseInt(process.env.FS_ESL_PORT || '8021');
  const eslPass = process.env.FS_ESL_PASSWORD || 'CHANGEME_ESL_PASS';
  const fsAudioDir = process.env.FS_AUDIO_DIR || '/tmp';

  if (!isShellSafe(fileUrl)) throw new Error(`eslBroadcast: unsafe fileUrl rejected: "${fileUrl}"`);
  if (!isShellSafe(fsAudioDir)) throw new Error(`eslBroadcast: unsafe FS_AUDIO_DIR rejected: "${fsAudioDir}"`);

  return new Promise((resolve, reject) => {
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      try { conn.disconnect(); } catch {}
      reject(err);
    }

    const conn = new EslConnection(eslHost, eslPort, eslPass, () => {
      // Extract filename from URL and build local path on FreeSWITCH host
      const fname = fileUrl.split('/').pop();
      const localPath = `${fsAudioDir}/${fname}`;

      // Step 1: download the WAV to FreeSWITCH local disk via curl
      conn.api('system', `curl -s "${fileUrl}" -o "${localPath}"`, () => {
        // Step 2: play from local path — no mod_http_cache, no SSL, no redirect issues
        conn.api('uuid_broadcast', `${fsUuid} "${localPath}" aleg`, () => {
          conn.disconnect();
          resolve();
        });
      });
    });
    conn.on('error', (err) => fail(new Error(`ESL error: ${err.message}`)));
    setTimeout(() => fail(new Error('ESL timeout')), 8000);
  });
}

// Write mulaw chunks as PCM16 WAV so FreeSWITCH mod_http_cache can play it
function writeMulawWavFile(mulawChunks, filename) {
  return new Promise((resolve, reject) => {
    const filePath = join(AUDIO_DIR, filename);
    const mulaw = Buffer.concat(mulawChunks);
    const pcm = mulawDecode(mulaw);
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);        // PCM fmt chunk = 16 bytes
    header.writeUInt16LE(1, 20);         // WAVE_FORMAT_PCM = 1
    header.writeUInt16LE(1, 22);         // mono
    header.writeUInt32LE(8000, 24);      // 8kHz
    header.writeUInt32LE(16000, 28);     // byte rate = 8000 * 1 * 2
    header.writeUInt16LE(2, 32);         // block align = 1 * 2
    header.writeUInt16LE(16, 34);        // bits per sample = 16
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    const ws = createWriteStream(filePath);
    ws.write(header);
    ws.write(pcm);
    ws.end();
    ws.on('finish', () => resolve(filePath));
    ws.on('error', reject);
  });
}

let fileSeq = 0;

export async function createFsCallHandler(ws, req, log) {
  const url = new URL(req.url, 'http://localhost');
  const direction    = url.searchParams.get('direction') || 'inbound';
  const voiceId      = url.searchParams.get('voiceId') || process.env.MINIMAX_VOICE_ID || 'Cantonese_GentleLady';
  const greetingText = url.searchParams.get('greetingText') || '';
  const systemPrompt = url.searchParams.get('systemPrompt') || '';
  const callerPhone  = url.searchParams.get('phone') || 'unknown';
  const llmProviderName = url.searchParams.get('llmProvider') || process.env.LLM_PROVIDER || 'auto';
  const ttsProviderName = url.searchParams.get('ttsProvider') || process.env.TTS_PROVIDER || 'auto';
  const sttProviderName = url.searchParams.get('sttProvider') || process.env.STT_PROVIDER || 'auto';

  const llmProv = llmProviderName === 'auto' ? await getDefaultLlmProvider() : getLlmProvider(llmProviderName);
  const ttsProv = ttsProviderName === 'auto' ? await getDefaultTtsProvider() : getTtsProvider(ttsProviderName);
  const sttProv = sttProviderName === 'auto' ? await getDefaultSttProvider() : getSttProvider(sttProviderName);
  log('fs-init', '🔌 PROVIDERS', `llm=${llmProv?.__name??'?'} tts=${ttsProv?.__name??'?'} stt=${sttProv?.__name??'?'}`);

  let callSid   = `fs-${Date.now()}`;
  let fsUuid    = url.searchParams.get('uuid') || null; // passed from dialplan ${uuid}
  // Reject malformed UUIDs to prevent shell injection via ESL curl command
  if (fsUuid && !isValidUuid(fsUuid)) {
    console.error(`[fs-stream] rejected invalid uuid from query: "${fsUuid}"`);
    fsUuid = null;
  }
  let phone     = callerPhone;
  let stt       = null;
  let state     = 'IDLE';
  let ttsLastAt = 0;
  let llmAborted = false;
  let _cancelTts = null; // cancel handle for active TTS stream
  let _sttErrorCount = 0; // consecutive STT errors — stop restarting after 5
  // Deferred ESL broadcast queue: if fsUuid is not yet known when playTts() runs,
  // stash entries here and drain all of them as soon as the UUID arrives.
  const _pendingEslPlay = [];

  // If uuid was passed in query string, update callSid immediately
  if (fsUuid) callSid = `fs-${fsUuid}`;

  async function eslPlay(chunks, onDone) {
    ttsLastAt = Date.now();
    const seq = ++fileSeq;
    const filename = `fs-${callSid}-${seq}.wav`;
    try {
      await writeMulawWavFile(chunks, filename);
      // Use BASE_URL (nginx proxy on FreeSWITCH host) for audio — plain HTTP
      const fileUrl = `${BASE_URL}/audio/${filename}`;
      log(callSid, '🔊 ESL PLAY', fileUrl);
      await eslBroadcast(fsUuid, fileUrl);
    } catch (err) {
      log(callSid, '⚠ ESL ERR', err.message);
    }

    // Clean up temp file after 60s (enough time for playback)
    setTimeout(() => {
      unlink(join(AUDIO_DIR, filename), () => {});
    }, 60000);

    onDone?.();
  }

  async function playTts(text, { onDone, onError } = {}) {
    const chunks = [];
    await new Promise((resolve) => {
      const handle = ttsProv.synthesizeToStream(text, {
        voiceId,
        onChunk(buf) { chunks.push(buf); },
        onDone() { _cancelTts = null; resolve(); },
        onError(err) { log(callSid, '⚠ TTS ERR', err.message); _cancelTts = null; resolve(); },
      });
      // Wrap cancel so it always resolves the promise, even if the provider skips onDone/onError
      _cancelTts = handle?.cancel ? () => { handle.cancel(); resolve(); } : null;
    });

    if (!chunks.length) {
      onDone?.();
      return;
    }

    if (!fsUuid) {
      // UUID not yet received — enqueue for later (preserves order)
      log(callSid, '⚠ NO UUID YET — deferring ESL play');
      _pendingEslPlay.push({ chunks, onDone });
      return;
    }

    await eslPlay(chunks, onDone);
  }

  function interrupt(reason) {
    if (state === 'SPEAKING' || state === 'THINKING') {
      log(callSid, '🔇 INTERRUPT', reason);
      _cancelTts?.(); _cancelTts = null;
      llmAborted = true;
      state = 'LISTENING';
    }
  }

  function startListening() {
    state = 'LISTENING';
    const prevStt = stt;
    let thisStt;
    thisStt = sttProv.createStream({
      onInterim(text) {
        if (stt !== thisStt) return; // superseded
        if (Date.now() - ttsLastAt < 1500) return;
        if ((state === 'SPEAKING' || state === 'THINKING') && text.length >= 2) {
          interrupt(`user interim: "${text.slice(0, 30)}"`);
        }
      },
      onFinal(text) {
        if (stt !== thisStt) {
          log(callSid, '🔇 STT SUPERSEDED (fs)', `dropped: "${text.slice(0, 30)}"`);
          return;
        }
        _sttErrorCount = 0; // successful transcript — reset error counter
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
        if (stt !== thisStt) return; // superseded
        _sttErrorCount++;
        log(callSid, '⚠ STT ERR', `${err.message} (errors=${_sttErrorCount})`);
        if (_sttErrorCount <= 5) {
          startListening();
        } else {
          log(callSid, '🚫 STT ERR LIMIT', 'too many consecutive STT errors — stopping restart loop');
        }
      },
      onSessionEnd(reason) {
        if (stt !== thisStt) return; // superseded — don't chain-restart
        // Azure closed the session (idle timeout, service restart) — reconnect silently
        log(callSid, '🔄 STT RECONNECT', reason);
        _sttErrorCount = 0; // session ended cleanly — reset error counter
        if (state !== 'IDLE') startListening();
      },
    });
    stt = thisStt;
    // Close the previous session AFTER the new one is ready to avoid a gap
    if (prevStt) prevStt.close?.();
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

    const llmStream = llmProv.stream(messages, phone);

    try {
      for await (const token of llmStream) {
        if (llmAborted) break;
        reply += token;
        ttsBuffer += token;

        if (/[。？！，\n]/.test(ttsBuffer)) {
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
        const newHistory = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }];
        await saveContext(callSid, newHistory.slice(-10));
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
            if (!isValidUuid(meta.uuid)) {
              log(callSid, '⚠ FS META INVALID UUID', `rejected: "${String(meta.uuid).slice(0, 40)}"`);
            } else {
              fsUuid = meta.uuid;
              callSid = `fs-${meta.uuid}`;
              log(callSid, '📋 FS META', `uuid=${meta.uuid}`);
              // Drain all deferred TTS entries in order
              if (_pendingEslPlay.length > 0) {
                const pending = _pendingEslPlay.splice(0);
                (async () => {
                  for (const { chunks, onDone } of pending) {
                    await eslPlay(chunks, onDone);
                  }
                })();
              }
            }
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
      _cancelTts?.();
      _cancelTts = null;
      stt?.close?.();
      stt = null;
    },
  };
}
