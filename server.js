import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import twilio from "twilio";
import { getContext, saveContext, getUserMemory, setResult, getResult, deleteResult, setProcessStart, getProcessStart, deleteProcessStart, getProviderConfig, setProviderConfig } from "./src/services/redisClient.js";
import { queryLLM } from "./src/services/openClawLlm.js";
import { synthesizeSpeech } from "./src/services/minimaxTts.js";
import { retrieveKnowledge } from "./src/services/qdrantClient.js";
import { transcribeAudio } from "./src/services/azureStt.js";
import { createCallHandler } from "./src/services/streamManager.js";
import { createFsCallHandler } from "./src/services/fsStreamHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

const LANGUAGE = process.env.TWILIO_LANGUAGE || 'zh-HK';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const FIRST_MESSAGE = process.env.FIRST_MESSAGE || '你好，我係祖兒呀，請問點稱呼你呀？';
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
app.post("/call", async (req, res) => {
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
app.post("/voice", (req, res) => {
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
  if (recentCalls.size > 200) {
    for (const [sid, ts] of recentCalls) {
      if (now - ts > 120000) recentCalls.delete(sid);
    }
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
    res.send(`
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="phone" value="${phone}" />
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

    const systemPrompt = `${SYSTEM_PROMPT}

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
app.post("/process", async (req, res) => {
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
app.post("/poll/:callSid", async (req, res) => {
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

// ── Admin: provider config ───────────────────────────────────────────────────

const VALID_LLM = ['auto', 'ctm', 'gemini', 'groq', 'openrouter', 'openclaw'];
const VALID_TTS = ['auto', 'ctm', 'minimax'];
const VALID_STT = ['auto', 'ctm', 'azure'];

function adminAuth(req, res, next) {
  const token = process.env.CONSOLE_API_TOKEN || process.env.SESSION_SECRET || '';
  const auth = req.headers['authorization'] || '';
  if (token && auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(express.json());

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

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`[server] running on port ${process.env.PORT || 3000}`);
});

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

wss_fs.on('connection', (ws, req) => {
  const pingTimer = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20000);
  const handler = createFsCallHandler(ws, req, log);
  ws.on('message', (data, isBinary) => handler.onMessage(data, isBinary));
  ws.on('close', (code, reason) => { clearInterval(pingTimer); handler.onClose(code, reason?.toString() || ''); });
  ws.on('error', (err) => console.error('[ws-fs] error:', err.message));
});
