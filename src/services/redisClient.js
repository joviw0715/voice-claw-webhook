import Redis from 'ioredis';

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

async function appendConversation(callSid, message) {
  const key = `conv:${callSid}`;

  let history = await getConversation(callSid);
  history.push(message);

  // ✅ trim history
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  await getClient().setex(key, CONVERSATION_TTL, JSON.stringify(history));
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

// ✅ Compatibility wrappers (for server.js)

async function getContext(callSid) {
  return await getConversation(callSid);
}

async function saveContext(callSid, history) {
  return await setConversation(callSid, history);
}

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

  // Name always overwrites — caller may give a different name on a new call
  const merged = {
    ...existing,
    ...updates,
    ...(updates.name ? { name: updates.name } : {}),
  };

  await getClient().setex(
    key,
    MEMORY_TTL,
    JSON.stringify(merged)
  );

  return merged;
}

// ✅ alias for consistency
async function saveUserMemory(phoneNumber, memory) {
  return await updateUserMemory(phoneNumber, memory);
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

async function fetchProviderConfigFromConsole() {
  const consoleUrl = (process.env.CONSOLE_CALLBACK_URL || '').replace(/\/$/, '');
  // Use CONSOLE_API_TOKEN only — never SESSION_SECRET, which is the HMAC key for session
  // cookies and must not be transmitted as a bearer token.
  const token = process.env.CONSOLE_API_TOKEN || '';
  if (!consoleUrl) return null;
  try {
    const res = await import('axios').then(m => m.default.get(
      `${consoleUrl}/api/admin/providers`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 3000 },
    ));
    return res.data;
  } catch (err) {
    console.warn('[providers] failed to fetch from console:', err.message);
    return null;
  }
}

async function getProviderConfig() {
  // Try Redis first (fast path)
  const raw = await getClient().get(PROVIDER_CONFIG_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* corrupted — fall through to source of truth */ }
  }

  // Redis miss — fetch from business console DB (source of truth)
  const config = await fetchProviderConfigFromConsole();
  if (config) {
    // Re-populate Redis cache
    await getClient().set(PROVIDER_CONFIG_KEY, JSON.stringify(config));
    console.log('[providers] rehydrated Redis from console DB:', config);
  }
  return config ?? {};
}

async function setProviderConfig(config) {
  await getClient().set(PROVIDER_CONFIG_KEY, JSON.stringify(config));
}

// ─────────────────────────────────────────────


export {
  getConversation,
  appendConversation,
  setConversation,
  getContext,
  saveContext,
  getUserMemory,
  updateUserMemory,
  saveUserMemory,
  setResult,
  getResult,
  deleteResult,
  setProcessStart,
  getProcessStart,
  deleteProcessStart,
  getProviderConfig,
  setProviderConfig,
};
