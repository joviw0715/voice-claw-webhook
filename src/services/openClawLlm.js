import axios from 'axios';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'https://voiceclaw.zeabur.app';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

/**
 * Query OpenClaw LLM via /v1/chat/completions endpoint
 * @param {Array} messages - Array of {role, content} messages
 * @param {string} sessionId - Session identifier (CallSid) for persistent sessions
 * @returns {string} The assistant's reply
 */
export async function queryLLM(messages, sessionId) {
  if (!OPENCLAW_TOKEN) {
    throw new Error('OPENCLAW_TOKEN is not set');
  }

  const clawPayload = {
    model: 'openclaw/default',
    messages,
    user: sessionId,
    openclaw: {
      session: {
        persistent: true,
      },
    },
  };

  try {
    const response = await axios.post(
      `${OPENCLAW_URL}/v1/chat/completions`,
      clawPayload,
      {
        headers: {
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json',
          'x-openclaw-session-key': sessionId,
        },
        timeout: 25000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content;
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
