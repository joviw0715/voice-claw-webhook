import * as openclaw from './openclaw.js';
import * as ctm from './ctm.js';
import * as gemini from './gemini.js';
import * as groq from './groq.js';
import * as openrouter from './openrouter.js';
import { getProviderConfig } from '../../services/redisClient.js';

const PROVIDERS = { openclaw, ctm, gemini, groq, openrouter };

export const getLlmProvider = (name) => PROVIDERS[name] ?? PROVIDERS.openclaw;

function autoDetectLlm() {
  const geminiDirect = process.env.USE_GEMINI_DIRECT === 'true';
  if (ctm.isAvailable()) return ctm;
  if (gemini.isAvailable() && (geminiDirect || true)) return gemini;
  if (groq.isAvailable()) return groq;
  if (openrouter.isAvailable()) return openrouter;
  return openclaw;
}

export async function getDefaultLlmProvider() {
  try {
    const config = await getProviderConfig();
    const name = config.llm;
    if (name && name !== 'auto') return getLlmProvider(name);
  } catch { /* Redis unavailable — fall through to env/auto */ }
  const envName = process.env.LLM_PROVIDER;
  if (envName && envName !== 'auto') return getLlmProvider(envName);
  return autoDetectLlm();
}

export async function* streamWithFallback(provider, messages, phone) {
  try {
    yield* provider.stream(messages, phone);
  } catch (err) {
    console.warn('[llm] provider failed, falling back to openclaw:', err.message);
    yield* openclaw.stream(messages, phone);
  }
}
