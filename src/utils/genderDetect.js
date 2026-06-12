const SAMPLE_RATE = 8000;
const MIN_MALE_HZ = 80;
const MAX_FEMALE_HZ = 300;
const FEMALE_THRESHOLD_HZ = 160; // below = male, above = female

// Autocorrelation-based pitch detection on 16-bit PCM buffer (Int16 LE).
// Returns dominant fundamental frequency in Hz, or 0 if no clear pitch found.
function detectPitch(pcmBuffer) {
  const sampleCount = pcmBuffer.length / 2;
  if (sampleCount < 400) return 0; // need at least 50ms at 8kHz

  // Use up to 1s for analysis to improve accuracy on phone audio
  const analyzeCount = Math.min(sampleCount, SAMPLE_RATE);
  const samples = new Float64Array(analyzeCount);
  for (let i = 0; i < analyzeCount; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768.0;
  }

  // RMS energy check — skip silent frames
  let rms = 0;
  for (let i = 0; i < analyzeCount; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / analyzeCount);
  if (rms < 0.005) return 0; // too quiet (phone silence threshold is lower)

  const minLag = Math.floor(SAMPLE_RATE / MAX_FEMALE_HZ); // ~27 samples at 300Hz
  const maxLag = Math.floor(SAMPLE_RATE / MIN_MALE_HZ);   // 100 samples at 80Hz

  let bestLag = 0;
  let bestCorr = -Infinity;

  // Compute r0 for normalization
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

  // Lower threshold for phone-quality audio (was 0.25, now 0.15)
  if (bestCorr < 0.15) return 0;

  return SAMPLE_RATE / bestLag;
}

// Returns { gender: 'male'|'female'|'unknown', hz: number, rms: number, corr: number }
export function detectGender(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 800) {
    return { gender: 'unknown', hz: 0, rms: 0, corr: 0, reason: 'too_short' };
  }

  const sampleCount = pcmBuffer.length / 2;
  const analyzeCount = Math.min(sampleCount, SAMPLE_RATE);
  const samples = new Float64Array(analyzeCount);
  for (let i = 0; i < analyzeCount; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768.0;
  }

  let rms = 0;
  for (let i = 0; i < analyzeCount; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / analyzeCount);
  if (rms < 0.005) {
    return { gender: 'unknown', hz: 0, rms: +rms.toFixed(4), corr: 0, reason: 'silent' };
  }

  const minLag = Math.floor(SAMPLE_RATE / MAX_FEMALE_HZ);
  const maxLag = Math.floor(SAMPLE_RATE / MIN_MALE_HZ);

  let bestLag = 0;
  let bestCorr = -Infinity;
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

  if (bestCorr < 0.15) {
    return { gender: 'unknown', hz: +(SAMPLE_RATE / bestLag).toFixed(1), rms: +rms.toFixed(4), corr: +bestCorr.toFixed(3), reason: 'low_corr' };
  }

  const hz = SAMPLE_RATE / bestLag;
  const gender = hz < FEMALE_THRESHOLD_HZ ? 'male' : 'female';
  return { gender, hz: +hz.toFixed(1), rms: +rms.toFixed(4), corr: +bestCorr.toFixed(3), reason: 'ok' };
}
