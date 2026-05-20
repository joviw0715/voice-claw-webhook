import axios from 'axios';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.anthropic.com/v1/messages';
const LLM_MODEL = process.env.LLM_MODEL || 'claude-haiku-4-5-20250514';
const LLM_TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || '0.5');
const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '250', 10);

export async function queryLLM(messages, systemPrompt) {
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set');
  }

  // Separate system message from user/assistant messages for Anthropic API
  let system = systemPrompt || '';
  const conversationMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = system ? `${system}\n\n${msg.content}` : msg.content;
    } else {
      conversationMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const payload = {
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
    messages: conversationMessages,
  };

  if (system) {
    payload.system = system;
  }

  const response = await axios.post(LLM_BASE_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    timeout: 30000,
  });

  // Anthropic Messages API returns content as an array of blocks
  const content = response.data?.content;
  if (Array.isArray(content) && content.length > 0) {
    return content.map(block => block.text || '').join('');
  }

  throw new Error('Anthropic API returned no content');
}
