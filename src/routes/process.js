'use strict';

const express = require('express');
const twilio = require('twilio');

const twilioValidation = require('../middleware/twilioValidation');
const { transcribeRecording } = require('../services/azureStt');
const { chat } = require('../services/openClawLlm');
const { synthesize } = require('../services/minimaxTts');
const {
  getConversation,
  setConversation,
  getUserMemory,
  updateUserMemory,
} = require('../services/redisClient');
const { searchKnowledge } = require('../services/qdrantClient');

const router = express.Router();

/**
 * POST /process
 *
 * Called by Twilio after a recording is complete.
 *
 * Pipeline:
 *   1. Validate Twilio signature.
 *   2. Fetch conversation history (Redis / CallSid), user memory (Redis / phone),
 *      and transcribe the recording (Azure STT) – all in parallel.
 *   3. Retrieve relevant knowledge snippets from Qdrant.
 *   4. Build prompt and call OpenClaw LLM.
 *   5. Synthesise the reply via MiniMax TTS.
 *   6. Persist updated conversation and user memory to Redis.
 *   7. Return TwiML that plays the synthesised audio and records the next turn.
 */
router.post('/', twilioValidation, async (req, res) => {
  const { CallSid, From, RecordingUrl } = req.body;

  if (!CallSid || !RecordingUrl) {
    return res.status(400).send('Missing CallSid or RecordingUrl');
  }

  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    // ── 1. Load context and transcribe in parallel ───────────────────────────
    const [conversationHistory, userMemory, userText] = await Promise.all([
      getConversation(CallSid),
      getUserMemory(From || ''),
      transcribeRecording(RecordingUrl),
    ]);

    if (!userText) {
      twiml.say({ voice: 'alice', language: 'zh-CN' }, '抱歉，我没有听清楚，请重新说一遍。');
      twiml.record({
        action: `${baseUrl}/process`,
        method: 'POST',
        maxLength: 30,
        playBeep: true,
        trim: 'trim-silence',
        transcribe: false,
      });
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // ── 2. Retrieve knowledge snippets ───────────────────────────────────────
    const knowledgeSnippets = await searchKnowledge(userText);

    // ── 3. Build system prompt ────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(userMemory, knowledgeSnippets);

    // ── 4. Build message list and call LLM ───────────────────────────────────
    const updatedHistory = [
      ...conversationHistory,
      { role: 'user', content: userText },
    ];

    const assistantReply = await chat(updatedHistory, systemPrompt);

    // ── 5. Synthesise speech ─────────────────────────────────────────────────
    const audioPath = await synthesize(assistantReply);
    const audioUrl = `${baseUrl}${audioPath}`;

    // ── 6. Persist ───────────────────────────────────────────────────────────
    const newHistory = [
      ...updatedHistory,
      { role: 'assistant', content: assistantReply },
    ];

    await Promise.all([
      setConversation(CallSid, newHistory),
      updateUserMemory(From || '', {
        lastCallSid: CallSid,
        lastSeen: new Date().toISOString(),
      }),
    ]);

    // ── 7. Respond with TwiML ────────────────────────────────────────────────
    twiml.play(audioUrl);

    // Continue the conversation: record the next user turn
    twiml.record({
      action: `${baseUrl}/process`,
      method: 'POST',
      maxLength: 30,
      playBeep: true,
      trim: 'trim-silence',
      transcribe: false,
    });
  } catch (err) {
    console.error('Error processing recording:', err);
    twiml.say({ voice: 'alice', language: 'zh-CN' }, '抱歉，系统发生了错误，请稍后再试。');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Builds a system prompt that includes the user's long-term memory and any
 * retrieved knowledge snippets.
 *
 * @param {Object}   userMemory        Key/value memory object
 * @param {string[]} knowledgeSnippets Relevant knowledge from Qdrant
 * @returns {string}
 */
function buildSystemPrompt(userMemory, knowledgeSnippets) {
  const lines = [
    '你是一个专业的智能语音助手。请用简洁、自然的中文回答用户的问题。',
  ];

  const memoryKeys = Object.keys(userMemory).filter(
    (k) => !['lastCallSid', 'lastSeen'].includes(k)
  );
  if (memoryKeys.length > 0) {
    lines.push('\n## 用户记忆');
    for (const key of memoryKeys) {
      lines.push(`- ${key}: ${userMemory[key]}`);
    }
  }

  if (knowledgeSnippets.length > 0) {
    lines.push('\n## 相关知识');
    knowledgeSnippets.forEach((snippet, i) => {
      lines.push(`${i + 1}. ${snippet}`);
    });
  }

  return lines.join('\n');
}

module.exports = router;
