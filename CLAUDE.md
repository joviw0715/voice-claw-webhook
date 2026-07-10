# voice-claw-webhook

Real-time Cantonese AI phone companion (祖兒) for eldercare via Twilio Voice.

## Stack
- Node.js (ESM), Express 5
- STT: Azure | CTM ASR (WebSocket)
- LLM: OpenClaw | Gemini | CTM Qwen | Groq | OpenRouter
- TTS: MiniMax | CTM TTS | Azure Neural
- Redis (ioredis) — conversation context, memory, poll results, provider config
- Qdrant — RAG knowledge base

## Run
```bash
npm start        # production
npm run dev      # nodemon watch
```

## Architecture
- `USE_MEDIA_STREAMS=true` → WebSocket streaming path (`/stream`, `/stream-fs`)
- `USE_MEDIA_STREAMS=false` → legacy record/poll path
- All routes in single `server.js`
- Admin console: `public/index.html` (dark glassmorphism SPA)

## Admin Console (`/`)
- Views: Overview, Logs, Providers, Configuration
- Auth: Bearer `CONSOLE_API_TOKEN` or `SESSION_SECRET`
- Routes: `GET /admin/logs`, `GET /admin/config`, `GET /admin/providers`, `POST /admin/providers`

## Deploy
Push to `staging` branch → Zeabur auto-deploys.

## Key Env Vars
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `AZURE_SPEECH_KEY`, `MINIMAX_API_KEY`, `REDIS_URL`, `QDRANT_URL`, `SESSION_SECRET`, `CONSOLE_API_TOKEN`, `USE_MEDIA_STREAMS`
