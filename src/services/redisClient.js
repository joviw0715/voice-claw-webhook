'use strict';

const Redis = require('ioredis');

let client;

/**
 * Returns a lazily-created Redis client.  Reads REDIS_URL from the environment.
 */
function getClient() {
  if (!client) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.error('Redis client error:', err.message);
    });
  }
  return client;
}

// ─── Conversation history (keyed by CallSid) ────────────────────────────────

const CONVERSATION_TTL = 60 * 60; // 1 hour

/**
 * Returns the conversation history for a Twilio call.
 *
 * @param {string} callSid
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
async function getConversation(callSid) {
  const raw = await getClient().get(`conv:${callSid}`);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Appends a message to the conversation history for a Twilio call and resets
 * the TTL.
 *
 * @param {string} callSid
 * @param {{role: string, content: string}} message
 */
async function appendConversation(callSid, message) {
  const key = `conv:${callSid}`;
  const history = await getConversation(callSid);
  history.push(message);
  await getClient().setex(key, CONVERSATION_TTL, JSON.stringify(history));
}

/**
 * Replaces the entire conversation history for a Twilio call.
 *
 * @param {string} callSid
 * @param {Array<{role: string, content: string}>} messages
 */
async function setConversation(callSid, messages) {
  await getClient().setex(`conv:${callSid}`, CONVERSATION_TTL, JSON.stringify(messages));
}

// ─── User memory (keyed by phone number) ────────────────────────────────────

const MEMORY_TTL = 60 * 60 * 24 * 30; // 30 days

/**
 * Returns the long-term memory object for a user (identified by phone number).
 *
 * @param {string} phoneNumber  E.164 format, e.g. "+8613800138000"
 * @returns {Promise<Object>}
 */
async function getUserMemory(phoneNumber) {
  const raw = await getClient().get(`mem:${phoneNumber}`);
  return raw ? JSON.parse(raw) : {};
}

/**
 * Merges `updates` into the user's existing memory and persists it.
 *
 * @param {string} phoneNumber
 * @param {Object} updates  Key/value pairs to merge in
 */
async function updateUserMemory(phoneNumber, updates) {
  const key = `mem:${phoneNumber}`;
  const existing = await getUserMemory(phoneNumber);
  const merged = { ...existing, ...updates };
  await getClient().setex(key, MEMORY_TTL, JSON.stringify(merged));
}

module.exports = {
  getConversation,
  appendConversation,
  setConversation,
  getUserMemory,
  updateUserMemory,
};
