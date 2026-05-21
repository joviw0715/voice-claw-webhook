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
