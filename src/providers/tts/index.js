import * as minimax from './minimax.js';
import * as ctm from './ctm.js';
import { getProviderConfig } from '../../services/redisClient.js';

const PROVIDERS = { minimax, ctm };

export const getTtsProvider = (name) => PROVIDERS[name] ?? PROVIDERS.minimax;

export async function getDefaultTtsProvider() {
  try {
    const config = await getProviderConfig();
    const name = config.tts;
    if (name && name !== 'auto') return getTtsProvider(name);
  } catch { /* Redis unavailable — fall through */ }
  const envName = process.env.TTS_PROVIDER;
  if (envName && envName !== 'auto') return getTtsProvider(envName);
  return ctm.isAvailable() ? ctm : minimax;
}
