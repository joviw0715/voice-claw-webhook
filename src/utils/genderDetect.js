const SAMPLE_RATE = 8000;
const MIN_MALE_HZ = 85;
const MAX_FEMALE_HZ = 255;
const FEMALE_THRESHOLD_HZ = 160; // below = male, above = female

// Autocorrelation-based pitch detection on 16-bit PCM buffer (Int16, little-endian).
// Returns dominant fundamental frequency in Hz, or 0 if no clear pitch found.
function detectPitch(pcmBuffer) {
  const sampleCount = pcmBuffer.length / 2;
  if (sampleCount < SAMPLE_RATE * 0.1) return 0; // need at least 100ms

  // Use up to 0.5s for analysis
  const analyzeCount = Math.min(sampleCount, SAMPLE_RATE * 0.5);
  const samples = new Float64Array(analyzeCount);
  for (let i = 0; i < analyzeCount; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768.0;
  }

  // RMS energy check — skip silent frames
  let rms = 0;
  for (let i = 0; i < analyzeCount; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / analyzeCount);
  if (rms < 0.01) return 0; // too quiet / silence

  // Autocorrelation over the voice pitch range
  const minLag = Math.floor(SAMPLE_RATE / MAX_FEMALE_HZ); // ~31 samples at 255Hz
  const maxLag = Math.floor(SAMPLE_RATE / MIN_MALE_HZ);   // ~94 samples at 85Hz

  let bestLag = 0;
  let bestCorr = -Infinity;

  // Normalize autocorrelation at lag 0
  let r0 = 0;
  for (let i = 0; i < analyzeCount; i++) r0 += samples[i] * samples[i];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const n = analyzeCount - lag;
    for (let i = 0; i < n; i++) corr += samples[i] * samples[i + lag];
    const normalized = corr / (r0 || 1);
    if (normalized > bestCorr) {
      bestCorr = normalized;
      bestLag = lag;
    }
  }

  // Require a reasonably strong autocorrelation peak
  if (bestCorr < 0.25) return 0;

  return SAMPLE_RATE / bestLag;
}

// Returns 'male', 'female', or 'unknown' from a 16-bit PCM Buffer.
export function detectGender(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 1600) return 'unknown'; // need at least 100ms at 8kHz

  const hz = detectPitch(pcmBuffer);
  if (hz === 0) return 'unknown';
  if (hz < FEMALE_THRESHOLD_HZ) return 'male';
  return 'female';
}
