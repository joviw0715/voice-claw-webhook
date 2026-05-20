import 'dotenv/config';
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { getContext, saveContext } from "./src/services/redisClient.js";
import { getUserMemory } from "./src/services/redisClient.js";
import { queryLLM } from "./src/services/openClawLlm.js";
import { synthesizeSpeech } from "./src/services/minimaxTts.js";
import { retrieveKnowledge } from "./src/services/qdrantClient.js";
import { transcribeAudio } from "./src/services/azureStt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

const LANGUAGE = process.env.TWILIO_LANGUAGE || 'zh-CN';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

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
          maxLength="30" timeout="3" playBeep="false"
          trim="trim-silence" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`.trim();
}

// Entry: Twilio call — greet and start listening
app.post("/voice", (req, res) => {
  const callSid = req.body?.CallSid || 'unknown';
  log(callSid, '📞 CALL STARTED', `from ${req.body?.From || 'unknown'}`);
  res.type("text/xml");
  res.send(`
<Response>
  <Say language="${LANGUAGE}">你好，请说话。</Say>
  <Record action="${BASE_URL}/process" method="POST"
          maxLength="30" timeout="3" playBeep="false"
          trim="trim-silence" />
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
});

// Processing pipeline
app.post("/process", async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const phone = req.body.From || 'unknown';
  const recordingUrl = req.body.RecordingUrl || '';
  const start = Date.now();

  log(callSid, '▶  PROCESS START', `from=${phone}`);

  // No recording — loop back
  if (!recordingUrl) {
    log(callSid, '⚠  NO RECORDING received, looping back');
    res.type("text/xml");
    res.send(`<Response><Redirect>${BASE_URL}/voice</Redirect></Response>`);
    return;
  }

  // Transcribe with Azure STT
  log(callSid, '3/6 STT    transcribing with Azure', `url=${recordingUrl}`);
  let userText;
  try {
    const t1 = Date.now();
    userText = await transcribeAudio(recordingUrl);
    log(callSid, '3/6 STT    ✓ (Azure)', `"${userText}" (${Date.now() - t1}ms)`);
  } catch (err) {
    log(callSid, '❌ STT ERROR', err.message);
    res.type("text/xml");
    res.send(`
<Response>
  <Say language="${LANGUAGE}">抱歉，语音识别失败，请再试一次。</Say>
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

  try {
    // 1. Load session context
    log(callSid, '1/6 REDIS  loading conversation + memory');
    let history = await getContext(callSid);
    const memory = await getUserMemory(phone);
    log(callSid, '1/6 REDIS  ✓', `history=${history.length} msgs, memory keys: ${Object.keys(memory).join(', ') || 'empty'}`);

    // 2. RAG knowledge retrieval
    log(callSid, '2/6 RAG    retrieving knowledge', `query="${userText.slice(0, 60)}"`);
    const t2 = Date.now();
    const knowledge = await retrieveKnowledge(userText);
    log(callSid, '2/6 RAG    ✓', `${knowledge.length} result(s) (${Date.now() - t2}ms)`);

    // 3. Build context and query LLM
    history.push({ role: "user", content: userText });
    if (history.length > 10) history = history.slice(-10);

    const systemPrompt = `You are a helpful voice assistant.

User memory:
${JSON.stringify(memory)}

Knowledge:
${knowledge.join('\n')}`;

    log(callSid, '4/6 LLM    querying', `history=${history.length} msgs`);
    const t3 = Date.now();
    const reply = await queryLLM([
      { role: "system", content: systemPrompt },
      ...history
    ]);
    log(callSid, '4/6 LLM    ✓', `"${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}" (${Date.now() - t3}ms)`);

    // 4. Save conversation
    history.push({ role: "assistant", content: reply });
    log(callSid, '5/6 REDIS  saving conversation', `${history.length} messages`);
    await saveContext(callSid, history);
    log(callSid, '5/6 REDIS  ✓');

    // 5. Text-to-Speech
    log(callSid, '6/6 TTS    synthesizing speech', `text length=${reply.length}`);
    const t4 = Date.now();
    const audioUrl = await synthesizeSpeech(reply);
    log(callSid, '6/6 TTS    ✓', `${audioUrl} (${Date.now() - t4}ms)`);

    log(callSid, '✅ DONE', `total=${Date.now() - start}ms`);

    // Play response then immediately start listening again
    res.type("text/xml");
    res.send(recordTwiml(audioUrl));

  } catch (err) {
    log(callSid, '❌ ERROR', `${err.message} (after ${Date.now() - start}ms)`);
    console.error(err);
    res.type("text/xml");
    res.send(`
<Response>
  <Say language="${LANGUAGE}">抱歉，出现了错误，请再试一次。</Say>
  <Redirect>${BASE_URL}/voice</Redirect>
</Response>`);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`[server] running on port ${process.env.PORT || 3000}`);
});
