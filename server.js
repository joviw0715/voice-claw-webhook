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

// Entry: Twilio call
app.post("/voice", (_req, res) => {
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
  try {
    const callSid = req.body.CallSid;
    const phone = req.body.From;
    const recordingUrl = req.body.RecordingUrl + ".wav";

    console.log("callSid:", callSid, "phone:", phone, "recordingUrl:", recordingUrl);

    let history = await getContext(callSid);
    const memory = await getUserMemory(phone);

    const userText = await transcribeAudio(recordingUrl);
    const knowledge = await retrieveKnowledge(userText);

    history.push({ role: "user", content: userText });

    if (history.length > 10) {
      history = history.slice(-10);
    }

    const systemPrompt = `You are a helpful voice assistant.

User memory:
${JSON.stringify(memory)}

Knowledge:
${knowledge.join('\n')}`;

    const reply = await queryLLM([
      { role: "system", content: systemPrompt },
      ...history
    ]);

    history.push({ role: "assistant", content: reply });
    await saveContext(callSid, history);

    const audioUrl = await synthesizeSpeech(reply);

    res.type("text/xml");
    res.send(`
<Response>
  <Play>${audioUrl}</Play>
  <Redirect>/voice</Redirect>
</Response>
`);
  } catch (err) {
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
  console.log("Server running");
});
