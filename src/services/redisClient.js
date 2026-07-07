import Redis from 'ioredis';
import axios from 'axios';
import httpsAgent from '../utils/httpAgent.js';

let client;

/**
 * Returns a lazily-created Redis client.
 */
function getClient() {
  if (!client) {
    const redisUrl = process.env.REDIS_CONNECTION_STRING;

    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      // In test env, disable reconnect to prevent hanging processes
      ...(process.env.NODE_ENV === 'test' ? { retryStrategy: () => null } : {}),
    });

    client.on('error', (err) => {
      console.error('Redis client error:', err.message);
    });
  }
  return client;
}

// ─────────────────────────────────────────────
// Conversation (CallSid-based)
// ─────────────────────────────────────────────

const CONVERSATION_TTL = 60 * 60; // 1 hour
const MAX_HISTORY = 10; // prevent LLM overload

async function getConversation(callSid) {
  const raw = await getClient().get(`conv:${callSid}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function setConversation(callSid, messages) {
  // ✅ ensure trimmed
  if (messages.length > MAX_HISTORY) {
    messages = messages.slice(-MAX_HISTORY);
  }

  await getClient().setex(
    `conv:${callSid}`,
    CONVERSATION_TTL,
    JSON.stringify(messages)
  );
}

// ✅ Compatibility aliases (for server.js)

export const getContext = getConversation;
export const saveContext = setConversation;

// ─────────────────────────────────────────────
// User Memory (Phone-based)
// ─────────────────────────────────────────────

const MEMORY_TTL = 60 * 60 * 24 * 30; // 30 days

async function getUserMemory(phoneNumber) {
  const raw = await getClient().get(`mem:${phoneNumber}`);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function updateUserMemory(phoneNumber, updates) {
  const key = `mem:${phoneNumber}`;
  const existing = await getUserMemory(phoneNumber);

  const merged = { ...existing, ...updates };

  await getClient().setex(
    key,
    MEMORY_TTL,
    JSON.stringify(merged)
  );

  return merged;
}

// ─────────────────────────────────────────────
// Async result (poll pattern for Twilio timeout avoidance)
// ─────────────────────────────────────────────

const RESULT_TTL = 120; // 2 minutes — enough for any call

async function setResult(callSid, audioUrl) {
  await getClient().setex(`result:${callSid}`, RESULT_TTL, audioUrl);
}

async function getResult(callSid) {
  return await getClient().get(`result:${callSid}`);
}

async function deleteResult(callSid) {
  await getClient().del(`result:${callSid}`);
}

async function setProcessStart(callSid, timestampMs) {
  await getClient().setex(`pstart:${callSid}`, RESULT_TTL, String(timestampMs));
}

async function getProcessStart(callSid) {
  const v = await getClient().get(`pstart:${callSid}`);
  return v ? parseInt(v) : null;
}

async function deleteProcessStart(callSid) {
  await getClient().del(`pstart:${callSid}`);
}

// ─────────────────────────────────────────────
// Provider config (global admin override)
// Source of truth: business console PostgreSQL (via CONSOLE_CALLBACK_URL)
// Fast cache: Redis (config:providers, no TTL — updated on every admin save)
// Fallback chain: Redis hit → return; Redis miss → fetch from console → re-cache → return
// ─────────────────────────────────────────────

const PROVIDER_CONFIG_KEY = 'config:providers';
const ASSISTANT_CONFIG_KEY = 'config:assistant';

async function fetchProviderConfigFromConsole() {
  const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
  // Use CONSOLE_API_TOKEN only — never SESSION_SECRET, which is the HMAC key for session
  // cookies and must not be transmitted as a bearer token.
  const token = process.env.CONSOLE_API_TOKEN || '';
  if (!consoleUrl) return null;
  try {
    const res = await axios.get(
      `${consoleUrl}/api/admin/providers`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 3000, httpsAgent },
    );
    const data = res.data;
    // Validate shape — a redirect to login returns HTML, not the expected JSON object
    if (!data || typeof data !== 'object' || !('llm' in data) && !('tts' in data) && !('stt' in data)) {
      console.warn('[providers] unexpected response from console (got non-JSON or login redirect)');
      return null;
    }
    return data;
  } catch (err) {
    console.warn('[providers] failed to fetch from console:', err.message);
    return null;
  }
}

async function getProviderConfig() {
  // Provider selection (llm/tts/stt) — synced from business-console via POST on every save.
  // TTL is a fallback only; the sync POST handles instant propagation.
  const raw = await getClient().get(PROVIDER_CONFIG_KEY);
  let providers = {};
  let needsRehydration = !raw;
  if (raw) {
    try { providers = JSON.parse(raw); } catch {
      await getClient().del(PROVIDER_CONFIG_KEY).catch(() => {});
      needsRehydration = true; // parse failed (e.g. HTML stored) — try to self-heal
    }
  }
  if (needsRehydration) {
    // Redis miss or corrupt — try to rehydrate from business console DB
    const config = await fetchProviderConfigFromConsole();
    if (config) {
      await getClient().setex(PROVIDER_CONFIG_KEY, 86400, JSON.stringify(config));
      console.log('[providers] rehydrated Redis from console DB:', config);
      providers = config;
    }
  }

  // Assistant config (systemPrompt/firstMessage) — no TTL, not in DB
  const rawAssistant = await getClient().get(ASSISTANT_CONFIG_KEY);
  let assistant = {};
  if (rawAssistant) {
    try { assistant = JSON.parse(rawAssistant); } catch {
      await getClient().del(ASSISTANT_CONFIG_KEY).catch(() => {});
    }
  }

  return { ...providers, ...assistant };
}

async function setProviderConfig(config) {
  const { systemPrompt, firstMessage, language, ...providers } = config;
  // Provider selection: 1hr TTL (instant update via sync POST; TTL is just eviction backstop)
  await getClient().setex(PROVIDER_CONFIG_KEY, 86400, JSON.stringify(providers));
  // Assistant config: no TTL (local-only, not backed by DB)
  const assistant = { ...(systemPrompt !== undefined && { systemPrompt }), ...(firstMessage !== undefined && { firstMessage }), ...(language !== undefined && { language }) };
  if (Object.keys(assistant).length > 0) {
    const existing = await getClient().get(ASSISTANT_CONFIG_KEY).then(r => r ? JSON.parse(r) : {}).catch(() => ({}));
    await getClient().set(ASSISTANT_CONFIG_KEY, JSON.stringify({ ...existing, ...assistant }));
  }
}

// ─────────────────────────────────────────────


export {
  getUserMemory,
  updateUserMemory,
  setResult,
  getResult,
  deleteResult,
  setProcessStart,
  getProcessStart,
  deleteProcessStart,
  getProviderConfig,
  setProviderConfig,
};
