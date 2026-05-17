router.post('/process', twilioValidation, async (req, res) => {
  const { CallSid, SpeechResult } = req.body;

  const userSpeech = SpeechResult || '';

  console.log('User said:', userSpeech);

  // 👉 Call OpenClaw / AI
  const aiRes = await fetch('https://voiceclaw.zeabur.app/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: userSpeech
    })
  });

  const data = await aiRes.json();
  const reply = data.reply || '對不起，我沒有聽清楚。';

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
    reply
  );

  res.type('text/xml');
  res.send(twiml.toString());
});
