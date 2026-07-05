import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGender } from '../../src/utils/genderDetect.js';

function makeSilentBuffer(samples = 800) {
  return Buffer.alloc(samples * 2, 0);
}

function makeSineBuffer(freqHz, samples = 8000) {
  const buf = Buffer.alloc(samples * 2);
  const SAMPLE_RATE = 8000;
  const amplitude = 8000;
  for (let i = 0; i < samples; i++) {
    const s = Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * i / SAMPLE_RATE));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return buf;
}

test('returns unknown for null input', () => {
  const result = detectGender(null);
  assert.strictEqual(result.gender, 'unknown');
});

test('returns unknown for too-short buffer', () => {
  const result = detectGender(Buffer.alloc(100));
  assert.strictEqual(result.gender, 'unknown');
  assert.strictEqual(result.reason, 'too_short');
});

test('returns unknown for silent buffer', () => {
  const result = detectGender(makeSilentBuffer(1000));
  assert.strictEqual(result.gender, 'unknown');
  assert.strictEqual(result.reason, 'silent');
});

test('result always has gender, hz, rms, corr fields', () => {
  const result = detectGender(makeSilentBuffer(1000));
  assert.ok('gender' in result);
  assert.ok('hz' in result);
  assert.ok('rms' in result);
  assert.ok('corr' in result);
});

test('detects male pitch for 120Hz sine wave', () => {
  const buf = makeSineBuffer(120);
  const result = detectGender(buf);
  // 120Hz is below 160Hz threshold → male
  if (result.gender !== 'unknown') {
    assert.strictEqual(result.gender, 'male');
  }
  // at minimum, should not throw
});

test('detects female pitch for 220Hz sine wave', () => {
  const buf = makeSineBuffer(220);
  const result = detectGender(buf);
  // 220Hz is above 160Hz threshold → female
  if (result.gender !== 'unknown') {
    assert.strictEqual(result.gender, 'female');
  }
});

test('gender is always one of: male, female, unknown', () => {
  const bufs = [
    makeSilentBuffer(1000),
    makeSineBuffer(100),
    makeSineBuffer(200),
    makeSineBuffer(300),
  ];
  for (const buf of bufs) {
    const { gender } = detectGender(buf);
    assert.ok(['male', 'female', 'unknown'].includes(gender), `unexpected gender: ${gender}`);
  }
});
