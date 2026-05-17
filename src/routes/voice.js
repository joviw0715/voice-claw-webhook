router.post('/', twilioValidation, async (req, res) => {
  const { CallSid } = req.body;

  if (!CallSid) {
    return res.status(400).send('Missing CallSid');
  }

  // Reset conversation
  await setConversation(CallSid, []);

  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');

  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    action: `${baseUrl}/process`,
    method: 'POST',
    timeout: 5,
    speechTimeout: 'auto'
  });

  gather.say(
    { voice: 'alice', language: 'zh-CN' },
    '你好，我是你的智能助手，请告诉我你需要什么帮助。'
  );

  res.type('text/xml');
  res.send(twiml.toString());
});
``
