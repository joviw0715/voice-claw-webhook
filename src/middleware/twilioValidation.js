'use strict';

const twilio = require('twilio');

/**
 * Express middleware that validates every incoming request carries a valid
 * Twilio signature.  Rejects with 403 if the signature is missing or invalid.
 */
function twilioValidation(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl = process.env.BASE_URL;

  if (!authToken || !baseUrl) {
    console.error('TWILIO_AUTH_TOKEN or BASE_URL environment variable is not set');
    return res.status(500).send('Server misconfiguration');
  }

  // Reconstruct the full URL that Twilio signed
  const url = baseUrl.replace(/\/$/, '') + req.originalUrl;
  const signature = req.headers['x-twilio-signature'] || '';
  const params = req.body || {};

  const isValid = twilio.validateRequest(authToken, signature, url, params);

  if (!isValid) {
    console.warn(`Invalid Twilio signature for ${req.originalUrl}`);
    return res.status(403).send('Forbidden');
  }

  next();
}

module.exports = twilioValidation;
