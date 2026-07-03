// G.711 μ-law (PCMU) decode: Buffer of μ-law bytes → Buffer of 16-bit signed PCM (little-endian)
// Twilio Media Streams sends 8kHz μ-law; Azure STT push-stream expects 8kHz 16-bit PCM.
export function decode(mulawBuffer) {
  const pcm = Buffer.allocUnsafe(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const u = ~mulawBuffer[i] & 0xFF;
    let t = ((u & 0x0F) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    const sample = (u & 0x80) ? (0x84 - t) : (t - 0x84);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return pcm;
}

// G.711 μ-law encode: 16-bit signed PCM sample → 8-bit μ-law byte
export function encodeSample(s16) {
  const BIAS = 33;
  let sign = 0;
  if (s16 < 0) { s16 = -s16; sign = 0x80; }
  s16 += BIAS;
  if (s16 > 32767) s16 = 32767;
  let exp = 7;
  for (let mask = 0x4000; (s16 & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  return (~(sign | (exp << 4) | ((s16 >> (exp + 3)) & 0x0F))) & 0xFF;
}

// PCM16LE @inputRate → μ-law @8kHz via nearest-neighbour decimation.
// inputRate defaults to 16000; set CTM_TTS_SAMPLE_RATE env var to match the source.
export function encodePcm16ToMulaw8k(pcmBuf, inputRate = 16000) {
  const ratio = inputRate / 8000;
  const inputSamples = Math.floor(pcmBuf.length / 2);
  const outLen = Math.floor(inputSamples / ratio);
  const out = Buffer.allocUnsafe(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = Math.round(i * ratio);
    out[i] = encodeSample(pcmBuf.readInt16LE(src * 2));
  }
  return out;
}
