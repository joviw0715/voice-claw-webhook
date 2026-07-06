import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import { createHmac, timingSafeEqual } from "crypto";
import axios from 'axios';
import twilio from "twilio";
import twilioValidation from "./src/middleware/twilioValidation.js";
import { getContext, saveContext, getUserMemory, setResult, getResult, deleteResult, setProcessStart, getProcessStart, deleteProcessStart, getProviderConfig, setProviderConfig } from "./src/services/redisClient.js";
import { queryLLM } from "./src/services/openClawLlm.js";
import { synthesizeSpeech } from "./src/services/minimaxTts.js";
import { retrieveKnowledge } from "./src/services/qdrantClient.js";
import { transcribeAudio } from "./src/services/azureStt.js";
import { createCallHandler } from "./src/services/streamManager.js";
import { createFsCallHandler } from "./src/services/fsStreamHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── In-memory log ring buffer (last 500 lines) ───────────────────────────────
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);

function captureLog(level, args) {
  const line = args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logBuffer.push({ ts: new Date().toISOString(), level, line });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

[['log','info',_origLog],['error','error',_origErr],['warn','warn',_origWarn]].forEach(([m,l,orig]) => { console[m] = (...a) => { captureLog(l,a); orig(...a); }; });

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const LANGUAGE = process.env.TWILIO_LANGUAGE || 'zh-HK';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const FIRST_MESSAGE = process.env.FIRST_MESSAGE || '你好，我係祖兒呀，請問點稱呼你呀？';

// Log CTM config at startup so misconfigurations are immediately visible
console.log('[startup] CTM config check:');
console.log(`  CTM_LLM_BASE_URL = ${process.env.CTM_LLM_BASE_URL || '(not set)'}`);
console.log(`  CTM_LLM_API_KEY  = ${process.env.CTM_LLM_API_KEY ? process.env.CTM_LLM_API_KEY.slice(0,8) + '...' : '(not set)'}`);
console.log(`  CTM_LLM_MODEL    = ${process.env.CTM_LLM_MODEL || 'Qwen (default)'}`);
console.log(`  USE_CTM_LLM      = ${process.env.USE_CTM_LLM || '(not set)'}`);
console.log(`  CTM_TTS_URL      = ${process.env.CTM_TTS_URL || '(not set)'}`);
console.log(`  CTM_ASR_URL      = ${process.env.CTM_ASR_URL || '(not set)'}`);
console.log(`  CTM_ASR_ACCESS_CODE = ${process.env.CTM_ASR_ACCESS_CODE ? process.env.CTM_ASR_ACCESS_CODE.slice(0,8) + '...' : '(not set)'}`);

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你係一個用廣東話嘅 AI 陪伴照護員，你的名字叫祖兒。如果 User memory 有用戶名字就用佢嘅名字稱呼佢；如果唔知名字，對話開始時先有禮貌地問佢點稱呼，然後一直用佢嘅名字。你係語音通話，唔係文字，所以：絕對禁止任何 markdown、bullet point、清單、表格、時間表、數字列表、標題；唔好長篇大論；每次只講一個意思、一句話。規則：全程廣東話，語速慢，句子短，一次一條問；安撫陪伴；佢嘅問題如果你有背景資料，識答就用口語簡單答；絕對唔好糾正錯誤記憶，用重述或選項式問題；不確定或急症徵象引導搵真人幫手；End Call 前必須有禮貌地跟用戶說再見';

function log(callSid, step, detail = '') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${callSid}] ${step}${detail ? ' — ' + detail : ''}`);
}

function recordTwiml(audioUrl = null) {
  const play = audioUrl ? `<Play>${audioUrl}</Play>` : '';
  return `
<Response>
  ${play}
  <Record action="${BASE_URL}/process" method="POST"
          maxLength="30" timeout="1" playBeep="false"
          trim="trim-silence" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`.trim();
}

// Tracks callSids we've already set up to detect Twilio webhook retries.
// On retry: skip the greeting but still return stream TwiML so the stream can reconnect.
const recentCalls = new Map(); // callSid → timestamp

// POST /call?to=+85212345678  — initiate an outbound call with no timeLimit
app.post("/call", adminAuth, async (req, res) => {
  const to = req.body?.to || req.query?.to;
  if (!to) return res.status(400).json({ error: 'missing "to" parameter' });
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  try {
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice`,
      // No timeLimit — defaults to 14400s (4 hours)
    });
    log(call.sid, '📞 OUTBOUND CALL INITIATED', `to=${to}`);
    res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('[call] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Entry: Twilio call — greet and start listening
app.post("/voice", twilioValidation, (req, res) => {
  const callSid = req.body?.CallSid || 'unknown';
  const direction = req.body?.Direction || '';
  // For outbound calls From=Twilio number, To=person being called — use To.
  // For inbound calls From=person calling — use From.
  const phone = direction.startsWith('outbound')
    ? (req.body?.To || 'unknown')
    : (req.body?.From || 'unknown');
  const callStatus = req.body?.CallStatus || '';

  // Twilio posts status callbacks to this same URL when a call ends —
  // returning TwiML here would start a new call session, causing a restart loop.
  if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(callStatus)) {
    log(callSid, '📵 STATUS CALLBACK (ignored)', callStatus);
    res.status(200).send('<Response></Response>');
    return;
  }

  // Detect Twilio webhook retries (same CallSid within 30s) — skip greeting on reconnect
  const now = Date.now();
  const isRetry = recentCalls.has(callSid);
  recentCalls.set(callSid, now);
  for (const [sid, ts] of recentCalls) {
    if (now - ts > 120000) recentCalls.delete(sid);
  }

  if (isRetry) {
    log(callSid, '🔄 RECONNECT /voice (skip greeting)', `from ${phone}`);
  } else {
    log(callSid, '📞 CALL STARTED', `from ${phone}`);
  }
  res.type("text/xml");

  if (process.env.USE_MEDIA_STREAMS === 'true') {
    // Streaming path: connect stream immediately — greeting is played by the server
    // through the WebSocket once the stream is established, so it plays exactly once
    // regardless of how many Twilio webhook retries occurred during cold start.
    const wsUrl = (BASE_URL || `https://${req.headers.host}`)
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://') + '/stream';
    // Escape XML attribute special chars so a malformed phone value can't break the TwiML
    const phoneAttr = phone.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.send(`
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="phone" value="${phoneAttr}" />
    </Stream>
  </Connect>
  <Hangup/>
</Response>`);
  } else {
    // Legacy record/webhook path
    res.send(`
<Response>
  <Say language="${LANGUAGE}">${FIRST_MESSAGE}</Say>
  <Record action="${BASE_URL}/process" method="POST"
          maxLength="30" timeout="1" playBeep="false"
          trim="trim-silence" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  }
});

// Background: RAG + LLM + TTS — stores audio URL in Redis when done
async function processAsync(callSid, phone, userText) {
  const start = Date.now();
  try {
    // 1. Load session context
    log(callSid, '1/5 REDIS  loading conversation + memory');
    let history = await getContext(callSid);
    const memory = await getUserMemory(phone);
    log(callSid, '1/5 REDIS  ✓', `history=${history.length} msgs, memory keys: ${Object.keys(memory).join(', ') || 'empty'}`);

    // 2. RAG knowledge retrieval
    log(callSid, '2/5 RAG    retrieving knowledge', `query="${userText.slice(0, 60)}"`);
    const t2 = Date.now();
    const knowledge = await retrieveKnowledge(userText);
    log(callSid, '2/5 RAG    ✓', `${knowledge.length} result(s) (${Date.now() - t2}ms)`);

    // 3. Build context and query LLM
    history.push({ role: "user", content: userText });
    if (history.length > 10) history = history.slice(-10);

    // Use Redis-stored systemPrompt if the admin has overridden it; fall back to env/constant
    let activeSystemPrompt = SYSTEM_PROMPT;
    try {
      const cfg = await getProviderConfig();
      if (cfg.systemPrompt) activeSystemPrompt = cfg.systemPrompt;
    } catch { /* Redis unavailable — use default */ }

    const systemPrompt = `${activeSystemPrompt}

User memory:
${JSON.stringify(memory)}

Knowledge:
${knowledge.join('\n')}

每次只講一至兩句，唔好長篇大論。`;

    log(callSid, '3/5 LLM    querying', `history=${history.length} msgs`);
    const t3 = Date.now();
    const reply = await queryLLM([
      { role: "system", content: systemPrompt },
      ...history
    ], phone);
    log(callSid, '3/5 LLM    ✓', `"${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}" (${Date.now() - t3}ms)`);

    // Strip name prefixes the LLM sometimes adds (e.g. "祖兒：", "AI：")
    const cleanReply = reply.replace(/^[一-鿿\w]+[：:]\s*/u, '').trim();

    // 4. Save conversation
    history.push({ role: "assistant", content: cleanReply });
    log(callSid, '4/5 REDIS  saving conversation', `${history.length} messages`);
    await saveContext(callSid, history);
    log(callSid, '4/5 REDIS  ✓');

    // 5. Text-to-Speech
    log(callSid, '5/5 TTS    synthesizing speech', `text length=${cleanReply.length}`);
    const t5 = Date.now();
    const audioUrl = await synthesizeSpeech(cleanReply);
    log(callSid, '5/5 TTS    ✓', `${audioUrl} (${Date.now() - t5}ms)`);

    // Store result for poll endpoint
    await setResult(callSid, audioUrl);
    log(callSid, '✅ ASYNC DONE', `total=${Date.now() - start}ms — stored in Redis for poll`);
  } catch (err) {
    log(callSid, '❌ ASYNC ERROR', `${err.message} (after ${Date.now() - start}ms)`);
    await setResult(callSid, 'ERROR');
  }
}

// Processing pipeline — STT only, then hand off to background + poll
app.post("/process", twilioValidation, async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const phone = req.body.From || 'unknown';
  const recordingUrl = req.body.RecordingUrl || '';
  const recordingDuration = req.body.RecordingDuration || '?';
  const start = Date.now();

  log(callSid, '▶  PROCESS START', `from=${phone} recordingDuration=${recordingDuration}s — Twilio silence+upload delay not logged above`);

  // No recording — loop back
  if (!recordingUrl) {
    log(callSid, '⚠  NO RECORDING received, looping back');
    res.type("text/xml");
    res.send(`<Response><Redirect>${BASE_URL}/voice</Redirect></Response>`);
    return;
  }

  // Transcribe with Azure STT
  log(callSid, 'STT   transcribing with Azure', `url=${recordingUrl}`);
  let userText;
  try {
    const t1 = Date.now();
    userText = await transcribeAudio(recordingUrl);
    log(callSid, 'STT   ✓ (Azure)', `"${userText}" (${Date.now() - t1}ms)`);
  } catch (err) {
    log(callSid, '❌ STT ERROR', err.message);
    res.type("text/xml");
    res.send(`
<Response>
  <Say language="${LANGUAGE}">唔好意思，語音識別出咗問題，請再講多次。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
    return;
  }

  // No speech detected — loop back
  if (!userText || !userText.trim()) {
    log(callSid, '⚠  NO SPEECH detected in recording, looping back');
    res.type("text/xml");
    res.send(`<Response><Redirect>${BASE_URL}/voice</Redirect></Response>`);
    return;
  }

  // Fire LLM + TTS in background — respond immediately so Twilio doesn't time out
  log(callSid, '⚡ ASYNC START', `launching background processing (${Date.now() - start}ms so far)`);
  setProcessStart(callSid, start).catch(() => {});
  processAsync(callSid, phone, userText);

  log(callSid, '📤 POLL REDIRECT', `redirecting Twilio to poll — STT total=${Date.now() - start}ms`);
  res.type("text/xml");
  res.send(`
<Response>
  <Say language="${LANGUAGE}">係，等我諗吓。</Say>
  <Pause length="12"/>
  <Redirect>${BASE_URL}/poll/${callSid}</Redirect>
</Response>`);
});

// Poll endpoint — Twilio calls this via POST (Redirect default) every ~3s until the audio is ready
app.post("/poll/:callSid", twilioValidation, async (req, res) => {
  const callSid = req.params.callSid;
  log(callSid, '🔄 POLL   checking result');

  const audioUrl = await getResult(callSid);

  if (!audioUrl) {
    log(callSid, '🔄 POLL   not ready yet, pausing 3s');
    res.type("text/xml");
    res.send(`
<Response>
  <Say language="${LANGUAGE}">再等一陣。</Say>
  <Pause length="3"/>
  <Redirect>${BASE_URL}/poll/${callSid}</Redirect>
</Response>`);
    return;
  }

  await deleteResult(callSid);

  if (audioUrl === 'ERROR') {
    deleteProcessStart(callSid).catch(() => {});
    log(callSid, '❌ POLL   background processing failed, looping back');
    res.type("text/xml");
    res.send(`
<Response>
  <Say language="${LANGUAGE}">唔好意思，出咗啲問題，請再試多次。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
    return;
  }

  const processStart = await getProcessStart(callSid).catch(() => null);
  const e2eMs = processStart ? Date.now() - processStart : null;
  deleteProcessStart(callSid).catch(() => {});
  const ttsReadyAt = new Date().toISOString();
  log(callSid, '📤 POLL   ready, sending audio', `${audioUrl}${e2eMs !== null ? ` — e2e=${e2eMs}ms (user finished speaking → audio ready @ ${ttsReadyAt}; add ~1s Twilio playback buffer for real perceived latency)` : ''}`);
  res.type("text/xml");
  res.send(recordTwiml(audioUrl));
});

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [UNCAUGHT EXCEPTION]`, err);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] [UNHANDLED REJECTION]`, reason);
});

// ── Diagnostic: test CTM LLM connectivity ───────────────────────────────────
app.get('/admin/test-ctm-llm', adminAuth, async (req, res) => {

  const baseUrl = (process.env.CTM_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.CTM_LLM_API_KEY || '';
  const model = process.env.CTM_LLM_MODEL || 'Qwen';

  if (!baseUrl) return res.json({ ok: false, error: 'CTM_LLM_BASE_URL not set' });
  if (!apiKey) return res.json({ ok: false, error: 'CTM_LLM_API_KEY not set' });

  // Validate URL format
  try { new URL(baseUrl); } catch {
    return res.json({ ok: false, error: `CTM_LLM_BASE_URL is not a valid URL: "${baseUrl}"` });
  }

  try {
    const response = await axios.post(`${baseUrl}/chat/completions`, {
      model,
      messages: [{ role: 'user', content: '你好' }],
      max_tokens: 10,
      chat_template_kwargs: { enable_thinking: false },
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const content = response.data.choices?.[0]?.message?.content ?? '(no content)';
    res.json({ ok: true, model, reply: content.slice(0, 100), base_url: baseUrl });
  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data)?.slice(0, 300) ?? err.message;
    res.json({ ok: false, status, error: detail, base_url: baseUrl });
  }
});



const VALID_LLM = ['auto', 'ctm', 'gemini', 'groq', 'openrouter', 'openclaw'];
const VALID_TTS = ['auto', 'ctm', 'minimax'];
const VALID_STT = ['auto', 'ctm', 'azure'];

// Signed session cookie using HMAC-SHA256.
// Cookie value: base64url(token) + '.' + hex(HMAC-SHA256(base64url(token), secret))
function signToken(tok) {
  const secret = process.env.CONSOLE_API_TOKEN || process.env.SESSION_SECRET || 'voiceclaw';
  const payload = Buffer.from(tok).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

function verifySessionCookie(cookie) {
  if (!cookie) return false;
  try {
    const dot = cookie.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = cookie.slice(0, dot);
    const tok = Buffer.from(payload, 'base64url').toString('utf8');
    const expected = signToken(tok);
    // Timing-safe comparison to prevent timing attacks
    if (expected.length !== cookie.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(cookie));
  } catch { return false; }
}

function adminAuth(req, res, next) {
  const serverToken = process.env.CONSOLE_API_TOKEN || process.env.SESSION_SECRET || '';
  if (!serverToken) return next();
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${serverToken}`;
  if (auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return next();
  // Accept session cookie (browser) — extract vc_session directly without building full dict
  const rawCookie = req.headers.cookie || '';
  const sessionVal = rawCookie.split(';').find(p => p.trim().startsWith('vc_session='))?.split('=').slice(1).join('=');
  if (verifySessionCookie(sessionVal)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin: login (sets session cookie) ──────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const serverToken = process.env.CONSOLE_API_TOKEN || process.env.SESSION_SECRET || '';
  const { token } = req.body ?? {};
  const supplied = Buffer.from(token ?? '');
  const expected = Buffer.from(serverToken);
  if (serverToken && !(supplied.length === expected.length && timingSafeEqual(supplied, expected))) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const signed = signToken(serverToken || 'dev');
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  res.setHeader('Set-Cookie', `vc_session=${signed}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/; Secure`);
  res.json({ ok: true });
});

// ── Admin: me (check current auth status) ───────────────────────────────────
app.get('/admin/me', (req, res) => {
  const serverToken = process.env.CONSOLE_API_TOKEN || process.env.SESSION_SECRET || '';
  if (!serverToken) return res.json({ authed: true, noToken: true });
  const cookies = parseCookies(req);
  const auth = req.headers['authorization'] || '';
  const expectedBearer = `Bearer ${serverToken}`;
  const bearerMatch = auth.length === expectedBearer.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expectedBearer));
  const authed = verifySessionCookie(cookies['vc_session']) || bearerMatch;
  res.json({ authed });
});

// ── Admin: stats — parsed from log buffer ────────────────────────────────────
app.get('/admin/stats', adminAuth, (req, res) => {
  const parseMs = str => { const m = str.match(/\((\d+)ms\)/); return m ? parseInt(m[1]) : null; };
  const parseTotalMs = str => { const m = str.match(/total=(\d+)ms/); return m ? parseInt(m[1]) : null; };

  const sttTimes = [], llmTimes = [], ttsTimes = [], totalTimes = [];
  const callSids = new Set();
  let callCount = 0;

  for (const { line } of logBuffer) {
    const sidMatch = line.match(/\[([A-Z]{2}[0-9a-f]{32})\]/);
    if (sidMatch) callSids.add(sidMatch[1]);
    if (line.includes('STT') && line.includes('✓')) {
      const ms = parseMs(line); if (ms) sttTimes.push(ms);
    }
    if (line.includes('3/5 LLM') && line.includes('✓')) {
      const ms = parseMs(line); if (ms) llmTimes.push(ms);
    }
    if (line.includes('5/5 TTS') && line.includes('✓')) {
      const ms = parseMs(line); if (ms) ttsTimes.push(ms);
    }
    if (line.includes('ASYNC DONE')) {
      const ms = parseTotalMs(line); if (ms) totalTimes.push(ms);
    }
    if (line.includes('CALL STARTED') || line.includes('OUTBOUND CALL INITIATED')) callCount++;
  }

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const p95 = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };

  res.json({
    calls: { total: callSids.size || callCount },
    latency: {
      stt:   { avg: avg(sttTimes),   p95: p95(sttTimes),   samples: sttTimes.length },
      llm:   { avg: avg(llmTimes),   p95: p95(llmTimes),   samples: llmTimes.length },
      tts:   { avg: avg(ttsTimes),   p95: p95(ttsTimes),   samples: ttsTimes.length },
      total: { avg: avg(totalTimes), p95: p95(totalTimes), samples: totalTimes.length },
    },
    errors: logBuffer.filter(l => l.level === 'error').length,
    warnings: logBuffer.filter(l => l.level === 'warn').length,
    logCount: logBuffer.length,
  });
});

app.get('/admin/providers', adminAuth, async (req, res) => {
  try {
    const config = await getProviderConfig();
    res.json({
      llm: config.llm || 'auto',
      tts: config.tts || 'auto',
      stt: config.stt || 'auto',
      valid: { llm: VALID_LLM, tts: VALID_TTS, stt: VALID_STT },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/providers', adminAuth, async (req, res) => {
  const { llm, tts, stt } = req.body ?? {};
  if (llm && !VALID_LLM.includes(llm)) return res.status(400).json({ error: `Invalid llm: ${llm}. Valid: ${VALID_LLM.join(', ')}` });
  if (tts && !VALID_TTS.includes(tts)) return res.status(400).json({ error: `Invalid tts: ${tts}. Valid: ${VALID_TTS.join(', ')}` });
  if (stt && !VALID_STT.includes(stt)) return res.status(400).json({ error: `Invalid stt: ${stt}. Valid: ${VALID_STT.join(', ')}` });
  try {
    const current = await getProviderConfig();
    const updated = {
      ...current,
      llm: llm ?? current.llm ?? 'auto',
      tts: tts ?? current.tts ?? 'auto',
      stt: stt ?? current.stt ?? 'auto',
    };
    await setProviderConfig(updated);
    console.log(`[admin] providers updated:`, updated);
    res.json({ ok: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: assistant config (system prompt + first message overrides) ────────
app.get('/admin/assistant', adminAuth, async (req, res) => {
  try {
    const cfg = await getProviderConfig();
    res.json({
      systemPrompt: cfg.systemPrompt ?? process.env.SYSTEM_PROMPT ?? SYSTEM_PROMPT,
      firstMessage: cfg.firstMessage ?? process.env.FIRST_MESSAGE ?? FIRST_MESSAGE,
      language:     cfg.language     ?? process.env.TWILIO_LANGUAGE ?? 'zh-HK',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/assistant', adminAuth, async (req, res) => {
  const { systemPrompt, firstMessage, language } = req.body ?? {};
  try {
    const current = await getProviderConfig();
    const updated = {
      ...current,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(firstMessage !== undefined ? { firstMessage } : {}),
      ...(language     !== undefined ? { language }     : {}),
    };
    await setProviderConfig(updated);
    if (firstMessage !== undefined) process.env.FIRST_MESSAGE = firstMessage;
    if (language !== undefined) process.env.TWILIO_LANGUAGE = language;
    console.log('[admin] assistant config updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: composer — test LLM without a phone call ──────────────────────────
app.post('/admin/chat', adminAuth, async (req, res) => {
  const { messages, phone = 'test' } = req.body ?? {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  try {
    const cfg = await getProviderConfig();
    const sysPrompt = cfg.systemPrompt || process.env.SYSTEM_PROMPT || SYSTEM_PROMPT;
    const full = [{ role: 'system', content: sysPrompt }, ...messages];
    const start = Date.now();
    const reply = await queryLLM(full, phone);
    res.json({ reply, ms: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: logs ─────────────────────────────────────────────────────────────
app.get('/admin/logs', adminAuth, (req, res) => {
  const since = req.query.since; // ISO timestamp — return only newer entries
  const level = req.query.level; // filter: info | error | warn
  let entries = logBuffer;
  if (since) entries = entries.filter(e => e.ts >= since);
  if (level) entries = entries.filter(e => e.level === level);
  res.json({ logs: entries });
});

// ── Admin: config (env snapshot — no secrets) ───────────────────────────────
app.get('/admin/config', adminAuth, (req, res) => {
  const safe = (key, mask = false) => {
    const v = process.env[key];
    if (!v) return null;
    return mask ? v.slice(0, 8) + '…' : v;
  };
  res.json({
    server: {
      PORT: safe('PORT') || '3000',
      BASE_URL: safe('BASE_URL'),
      USE_MEDIA_STREAMS: safe('USE_MEDIA_STREAMS') || 'false',
    },
    twilio: {
      TWILIO_ACCOUNT_SID: safe('TWILIO_ACCOUNT_SID', true),
      TWILIO_FROM_NUMBER: safe('TWILIO_FROM_NUMBER'),
      TWILIO_LANGUAGE: safe('TWILIO_LANGUAGE') || 'zh-HK',
    },
    llm: {
      LLM_PROVIDER: safe('LLM_PROVIDER') || 'auto',
      OPENCLAW_URL: safe('OPENCLAW_URL'),
      OPENCLAW_TOKEN: safe('OPENCLAW_TOKEN', true),
      GEMINI_MODEL: safe('GEMINI_MODEL'),
      USE_GEMINI_DIRECT: safe('USE_GEMINI_DIRECT') || 'false',
      LLM_MODEL: safe('LLM_MODEL'),
      USE_CTM_LLM: safe('USE_CTM_LLM') || 'false',
      CTM_LLM_BASE_URL: safe('CTM_LLM_BASE_URL'),
      CTM_LLM_MODEL: safe('CTM_LLM_MODEL'),
    },
    tts: {
      TTS_PROVIDER: safe('TTS_PROVIDER') || 'auto',
      MINIMAX_MODEL: safe('MINIMAX_MODEL'),
      MINIMAX_VOICE_ID: safe('MINIMAX_VOICE_ID'),
      AZURE_TTS_VOICE: safe('AZURE_TTS_VOICE'),
      USE_CTM_TTS: safe('USE_CTM_TTS') || 'false',
      CTM_TTS_URL: safe('CTM_TTS_URL'),
      CTM_TTS_VOICE: safe('CTM_TTS_VOICE'),
      CTM_TTS_SAMPLE_RATE: safe('CTM_TTS_SAMPLE_RATE'),
    },
    stt: {
      STT_PROVIDER: safe('STT_PROVIDER') || 'auto',
      AZURE_SPEECH_REGION: safe('AZURE_SPEECH_REGION'),
      AZURE_SPEECH_LANGUAGE: safe('AZURE_SPEECH_LANGUAGE'),
      USE_CTM_STT: safe('USE_CTM_STT') || 'false',
      CTM_ASR_URL: safe('CTM_ASR_URL'),
      CTM_ASR_LANGUAGE: safe('CTM_ASR_LANGUAGE'),
    },
    storage: {
      REDIS_CONNECTION_STRING: safe('REDIS_CONNECTION_STRING', true),
      QDRANT_URL: safe('QDRANT_URL'),
      QDRANT_COLLECTION: safe('QDRANT_COLLECTION'),
    },
  });
});

const server = app.listen(process.env.PORT || 3000, () => {
  const addr = server.address();
  const port = addr?.port ?? process.env.PORT ?? 3000;
  console.log(`[server] running on port ${port}`);
});

export { server, app };

// Single WebSocket server — route by path to support both Twilio (/stream) and FreeSWITCH (/stream-fs)
const wss = new WebSocketServer({ noServer: true });
const wss_fs = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/stream-fs') {
    wss_fs.handleUpgrade(req, socket, head, (ws) => wss_fs.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const pingTimer = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20000);
  const handler = createCallHandler(ws, log);
  ws.on('message', (data) => handler.onMessage(data.toString()));
  ws.on('close', (code, reason) => { clearInterval(pingTimer); handler.onClose(code, reason?.toString() || ''); });
  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

wss_fs.on('connection', async (ws, req) => {
  const pingTimer = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20000);
  let handler;
  try {
    handler = await createFsCallHandler(ws, req, log);
  } catch (err) {
    console.error('[ws-fs] handler init failed:', err.message);
    clearInterval(pingTimer);
    ws.close();
    return;
  }
  ws.on('message', (data, isBinary) => handler.onMessage(data, isBinary));
  ws.on('close', (code, reason) => { clearInterval(pingTimer); handler.onClose(code, reason?.toString() || ''); });
  ws.on('error', (err) => console.error('[ws-fs] error:', err.message));
});
