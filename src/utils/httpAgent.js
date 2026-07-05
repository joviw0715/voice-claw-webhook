import https from 'https';

/**
 * Shared HTTPS agent with keep-alive enabled.
 * Reusing TCP connections across requests significantly reduces latency for
 * repeated calls to the same host (LLM, TTS, STT, embedding, console webhook).
 *
 * maxSockets / maxFreeSockets are intentionally generous — each service file
 * that imports this agent reaches a different remote host, so actual per-host
 * socket counts stay well within these limits.
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

export default httpsAgent;
