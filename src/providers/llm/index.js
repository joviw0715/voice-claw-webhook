import * as openclaw from './openclaw.js';
import * as ctm from './ctm.js';
import * as gemini from './gemini.js';
import * as groq from './groq.js';
import * as openrouter from './openrouter.js';
import { getProviderConfig } from '../../services/redisClient.js';

const PROVIDERS = { openclaw, ctm, gemini, groq, openrouter };

export const getLlmProvider = (name) => PROVIDERS[name] ?? PROVIDERS.openclaw;

function autoDetectLlm() {
  if (ctm.isAvailable()) return ctm;
  if (gemini.isAvailable()) return gemini;
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
  // Try the configured provider first (all providers, including openclaw)
  let yielded = false;
  try {
    for await (const tok of provider.stream(messages, phone)) {
      yielded = true;
      yield tok;
    }
    if (yielded) return; // success — don't fall through
  } catch (err) {
    if (yielded) {
      // Partial tokens already sent to caller — appending a fallback response
      // would produce garbled speech. Rethrow so the caller handles the broken turn.
      throw err;
    }
    console.warn(`[llm] ${provider.__name ?? 'provider'} failed (${err.message}), trying fallback`);
  }

  // Fallback chain: gemini → openrouter → openclaw (skip the primary provider)
  const fallbacks = [gemini, openrouter, openclaw].filter(p => p !== provider);
  for (const fb of fallbacks) {
    if (!fb.isAvailable() && fb !== openclaw) continue;
    try {
      let fbYielded = false;
      for await (const tok of fb.stream(messages, phone)) {
        fbYielded = true;
        yield tok;
      }
      if (fbYielded) {
        console.warn(`[llm] used fallback: ${fb.__name}`);
        return;
      }
    } catch (err) {
      console.warn(`[llm] fallback ${fb.__name} also failed: ${err.message}`);
    }
  }

  // All providers failed — yield a safe sorry message so caller hears something
  console.error('[llm] all providers failed — yielding fallback response');
  yield '唔好意思，系統暫時唔可用，請稍後再試。';
}
