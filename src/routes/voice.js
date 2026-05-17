'use strict';

const express = require('express');
const twilio = require('twilio');

const twilioValidation = require('../middleware/twilioValidation');
const { setConversation } = require('../services/redisClient');

const router = express.Router();

/**
 * POST /voice
 *
 * Entry point for all incoming Twilio calls.
 *
 * 1. Validates the Twilio request signature.
 * 2. Initialises an empty conversation history in Redis for this CallSid.
 * 3. Returns TwiML that greets the caller and starts recording.
 *    The recording is sent to /process when complete.
 */
router.post('/', twilioValidation, async (req, res) => {
  const { CallSid, From } = req.body;

  if (!CallSid) {
    return res.status(400).send('Missing CallSid');
  }

  // Initialise fresh conversation for this call
  await setConversation(CallSid, []);

  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: 'alice', language: 'zh-CN' },
    '你好，我是你的智能助手，请在提示音后说话。'
  );
  twiml.record({
    action: `${baseUrl}/process`,
    method: 'POST',
    maxLength: 30,
    playBeep: true,
    trim: 'trim-silence',
    transcribe: false,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

module.exports = router;
