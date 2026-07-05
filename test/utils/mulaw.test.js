import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSample, decode, encodePcm16ToMulaw8k } from '../../src/utils/mulaw.js';

test('encodeSample produces values in 0–255 range', () => {
  for (const s of [-32768, -16000, -1, 0, 1, 16000, 32767]) {
    const v = encodeSample(s);
    assert.ok(v >= 0 && v <= 255, `encodeSample(${s}) = ${v} out of range`);
  }
});

test('encodeSample silence (0) produces consistent output', () => {
  const v = encodeSample(0);
  assert.strictEqual(v, encodeSample(0));
});

test('decode produces buffer twice the input length', () => {
  const input = Buffer.from([0x00, 0x7F, 0xFF, 0x80]);
  const out = decode(input);
  assert.strictEqual(out.length, input.length * 2);
});

test('decode output samples are in Int16 range', () => {
  const input = Buffer.alloc(16, 0x7F);
  const out = decode(input);
  for (let i = 0; i < out.length; i += 2) {
    const s = out.readInt16LE(i);
    assert.ok(s >= -32768 && s <= 32767, `sample ${s} out of int16 range`);
  }
});

test('round-trip encode→decode is approximately reversible', () => {
  const samples = [0, 100, 1000, 5000, 10000, -100, -5000, -10000];
  for (const original of samples) {
    const encoded = encodeSample(original);
    const muBuf = Buffer.from([encoded]);
    const decoded = decode(muBuf).readInt16LE(0);
    // μ-law is lossy — allow tolerance
    const tolerance = Math.abs(original) * 0.15 + 100;
    assert.ok(
      Math.abs(decoded - original) <= tolerance,
      `round-trip for ${original}: got ${decoded}, tolerance ${tolerance}`
    );
  }
});

test('encodePcm16ToMulaw8k converts 16kHz PCM to 8kHz μ-law', () => {
  const inputSamples = 160; // 10ms at 16kHz
  const pcm = Buffer.alloc(inputSamples * 2, 0);
  const out = encodePcm16ToMulaw8k(pcm, 16000);
  // 16kHz → 8kHz = half the samples
  assert.strictEqual(out.length, inputSamples / 2);
  assert.ok(out.every(b => b >= 0 && b <= 255));
});

test('encodePcm16ToMulaw8k handles 8kHz passthrough', () => {
  const inputSamples = 80; // 10ms at 8kHz
  const pcm = Buffer.alloc(inputSamples * 2, 0);
  const out = encodePcm16ToMulaw8k(pcm, 8000);
  assert.strictEqual(out.length, inputSamples);
});
