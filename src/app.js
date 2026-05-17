'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const voiceRoute = require('./routes/voice');
const processRoute = require('./routes/process');

const app = express();

// Parse URL-encoded bodies sent by Twilio
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve generated TTS audio files
app.use('/audio', express.static(path.join(__dirname, '..', 'audio')));

// Routes
app.use('/voice', voiceRoute);
app.use('/process', processRoute);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
