import * as azure from './azure.js';
import * as ctm from './ctm.js';
import { getProviderConfig } from '../../services/redisClient.js';

const PROVIDERS = { azure, ctm };

export const getSttProvider = (name) => PROVIDERS[name] ?? PROVIDERS.azure;

export async function getDefaultSttProvider() {
  try {
    const config = await getProviderConfig();
    const name = config.stt;
    if (name && name !== 'auto') return getSttProvider(name);
  } catch { /* Redis unavailable — fall through */ }
  const envName = process.env.STT_PROVIDER;
  if (envName && envName !== 'auto') return getSttProvider(envName);
  return ctm.isAvailable() ? ctm : azure;
}
