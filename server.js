import 'dotenv/config';
import express from "express";
import { getContext, saveContext } from "./src/services/redisClient.js";
import { getUserMemory } from "./src/services/redisClient.js";
import { transcribeAudio } from "./src/services/elevenLabsStt.js";
import { queryLLM } from "./src/services/openClawLlm.js";
import { synthesizeSpeech } from "./src/services/minimaxTts.js";
import { retrieveKnowledge } from "./src/services/qdrantClient.js";

const app = express();
app.use(express.urlencoded({ extended: false }));

function log(callSid, step, detail = '') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${callSid}] ${step}${detail ? ' — ' + detail : ''}`);
}

// Entry: Twilio call
app.post("/voice", (req, res) => {
  const callSid = req.body?.CallSid || 'unknown';
  log(callSid, '📞 CALL STARTED', `from ${req.body?.From || 'unknown'}`);
  res.type("text/xml");
  res.send(`
<Response>
  <Say>Hello, please speak after the beep.</Say>
  <Record action="/process" method="POST"/>
</Response>
`);
});

// Processing pipeline
app.post("/process", async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const phone = req.body.From || 'unknown';
  const recordingUrl = req.body.RecordingUrl + ".wav";
  const start = Date.now();

  log(callSid, '▶  PROCESS START', `from=${phone}`);

  try {
    // 1. Load session context
    log(callSid, '1/7 REDIS  loading conversation history');
    let history = await getContext(callSid);
    log(callSid, '1/7 REDIS  ✓', `${history.length} messages in history`);

    log(callSid, '2/7 REDIS  loading user memory');
    const memory = await getUserMemory(phone);
    log(callSid, '2/7 REDIS  ✓', `memory keys: ${Object.keys(memory).join(', ') || 'empty'}`);

    // 2. Speech-to-Text
    log(callSid, '3/7 STT    transcribing audio', recordingUrl);
    const t1 = Date.now();
    const userText = await transcribeAudio(recordingUrl);
    log(callSid, '3/7 STT    ✓', `"${userText}" (${Date.now() - t1}ms)`);

    // 3. RAG knowledge retrieval
    log(callSid, '4/7 RAG    retrieving knowledge', `query="${userText.slice(0, 60)}"`);
    const t2 = Date.now();
    const knowledge = await retrieveKnowledge(userText);
    log(callSid, '4/7 RAG    ✓', `${knowledge.length} result(s) (${Date.now() - t2}ms)`);

    // 4. Build context and query LLM
    history.push({ role: "user", content: userText });
    if (history.length > 10) history = history.slice(-10);

    log(callSid, '5/7 LLM    querying', `history=${history.length} msgs, knowledge=${knowledge.length} chunks`);
    const t3 = Date.now();
    const systemPrompt = `You are a helpful voice assistant.

User memory:
${JSON.stringify(memory)}

Knowledge:
${knowledge.join('\n')}`;

    const reply = await queryLLM([
      { role: "system", content: systemPrompt },
      ...history
    ]);
    log(callSid, '5/7 LLM    ✓', `"${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}" (${Date.now() - t3}ms)`);

    // 5. Save conversation
    history.push({ role: "assistant", content: reply });
    log(callSid, '6/7 REDIS  saving conversation', `${history.length} messages`);
    await saveContext(callSid, history);
    log(callSid, '6/7 REDIS  ✓');

    // 6. Text-to-Speech
    log(callSid, '7/7 TTS    synthesizing speech', `text length=${reply.length}`);
    const t4 = Date.now();
    const audioUrl = await synthesizeSpeech(reply);
    log(callSid, '7/7 TTS    ✓', `${audioUrl} (${Date.now() - t4}ms)`);

    log(callSid, '✅ DONE', `total=${Date.now() - start}ms`);

    res.type("text/xml");
    res.send(`
<Response>
  <Play>${audioUrl}</Play>
  <Redirect>/voice</Redirect>
</Response>
`);
  } catch (err) {
    log(callSid, '❌ ERROR', `${err.message} (after ${Date.now() - start}ms)`);
    console.error(err);

    res.type("text/xml");
    res.send(`
<Response>
  <Say>Something went wrong</Say>
</Response>
`);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`[server] running on port ${process.env.PORT || 3000}`);
});
