import { test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';

// Import the middleware (ESM now)
import twilioValidation from '../../src/middleware/twilioValidation.js';

// Stub twilio.validateRequest
const originalValidate = twilio.validateRequest;

function makeReq(overrides = {}) {
  return {
    originalUrl: '/voice',
    headers: { 'x-twilio-signature': 'valid-sig' },
    body: { CallSid: 'CA123' },
    ...overrides,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    _body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this._body = body; return this; },
  };
}

test('passes when token+url set and signature is valid', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.BASE_URL = 'https://example.com';
  twilio.validateRequest = () => true;

  const res = makeRes();
  let nextCalled = false;
  twilioValidation(makeReq(), res, () => { nextCalled = true; });

  assert.ok(nextCalled, 'next() should be called for valid signature');
  twilio.validateRequest = originalValidate;
});

test('returns 403 when signature is invalid', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.BASE_URL = 'https://example.com';
  twilio.validateRequest = () => false;

  const res = makeRes();
  let nextCalled = false;
  twilioValidation(makeReq(), res, () => { nextCalled = true; });

  assert.ok(!nextCalled);
  assert.strictEqual(res.statusCode, 403);
  twilio.validateRequest = originalValidate;
});

test('returns 403 when x-twilio-signature header is missing', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.BASE_URL = 'https://example.com';
  twilio.validateRequest = () => false;

  const res = makeRes();
  let nextCalled = false;
  twilioValidation(makeReq({ headers: {} }), res, () => { nextCalled = true; });

  assert.ok(!nextCalled);
  assert.strictEqual(res.statusCode, 403);
  twilio.validateRequest = originalValidate;
});

test('returns 500 when TWILIO_AUTH_TOKEN is not set', () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  process.env.BASE_URL = 'https://example.com';

  const res = makeRes();
  let nextCalled = false;
  twilioValidation(makeReq(), res, () => { nextCalled = true; });

  assert.ok(!nextCalled);
  assert.strictEqual(res.statusCode, 500);
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
});

test('returns 500 when BASE_URL is not set', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  delete process.env.BASE_URL;

  const res = makeRes();
  let nextCalled = false;
  twilioValidation(makeReq(), res, () => { nextCalled = true; });

  assert.ok(!nextCalled);
  assert.strictEqual(res.statusCode, 500);
  process.env.BASE_URL = 'https://example.com';
});
