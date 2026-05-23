import fs from 'fs';
import path from 'path';

// Loads a PCM16 16kHz mono audio file and returns a Buffer.
// Strips a 44-byte WAV header if present.
function loadPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  // WAV files start with "RIFF" — strip the 44-byte header
  if (buf.length > 44 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    return buf.subarray(44);
  }
  return buf;
}

let ambientBuf = null;
let ambientPos = 0;
let ambientInitDone = false; // attempt load only once

function initAmbient() {
  if (ambientInitDone) return;
  ambientInitDone = true;
  const filePath = process.env.AMBIENT_AUDIO_FILE;
  if (!filePath) return;
  try {
    ambientBuf = loadPcm(path.resolve(filePath));
    console.log(`[ambient] loaded ${filePath} (${ambientBuf.length} bytes, ~${(ambientBuf.length / 32000).toFixed(1)}s)`);
  } catch (err) {
    console.warn('[ambient] failed to load file:', err.message);
  }
}

// Mix ambient PCM16 into a TTS PCM16 buffer (both @16kHz mono).
// Returns a new buffer with the mixed output.
export function mixAmbient(ttsPcm) {
  initAmbient();
  if (!ambientBuf || ambientBuf.length < 2) return ttsPcm;

  const vol = parseFloat(process.env.AMBIENT_VOLUME || '0.15');
  const out = Buffer.allocUnsafe(ttsPcm.length);
  const ambLen = ambientBuf.length & ~1; // align to 2-byte samples

  for (let i = 0; i < ttsPcm.length - 1; i += 2) {
    const tts = ttsPcm.readInt16LE(i);
    const amb = ambientBuf.readInt16LE(ambientPos % ambLen);
    const mixed = Math.max(-32768, Math.min(32767, tts + Math.round(amb * vol)));
    out.writeInt16LE(mixed, i);
    ambientPos = (ambientPos + 2) % ambLen;
  }
  return out;
}
