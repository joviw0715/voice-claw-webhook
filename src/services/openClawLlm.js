import axios from 'axios';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'https://voiceclaw.zeabur.app/api/chat';

/**
 * Query OpenClaw LLM via voiceclaw.zeabur.app
 * @param {Array} messages - Array of {role, content} messages
 * @returns {string} The assistant's reply
 */
export async function queryLLM(messages) {
  // Extract the latest user message to send to OpenClaw
  const lastUserMessage = [...messages]
    .reverse()
    .find(m => m.role === 'user');

  const userText = lastUserMessage?.content || '';

  if (!userText) {
    throw new Error('No user message found in conversation');
  }

  try {
    const response = await axios.post(OPENCLAW_URL, {
      message: userText,
    }, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    const reply = response.data?.reply;
    if (!reply) {
      console.error('OpenClaw unexpected response:', JSON.stringify(response.data, null, 2));
      throw new Error('OpenClaw returned no reply');
    }

    return reply;
  } catch (err) {
    if (err.response) {
      console.error('OpenClaw API error:', {
        status: err.response.status,
        data: err.response.data,
      });
      throw new Error(`OpenClaw API error (${err.response.status}): ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}
