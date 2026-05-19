# 🏇 UK Racing Analyst Pro

AI-powered UK horse racing prediction engine using 10 mathematical models:
Bayesian Form · Poisson Win Probability · Kelly Criterion · ELO Rating · Going Matrix · Draw Bias · Class Adjustment · Weight Model · Market Bayesian Update · Consistency Index

## Deploy to Render (Free)

1. Push this repo to GitHub
2. Go to render.com → New → Web Service
3. Connect this repo
4. Set these settings:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Add environment variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your Anthropic API key (from console.anthropic.com)
6. Deploy — your app will be live at `https://your-app.onrender.com`

## Local Development

```bash
# Install server deps
npm install

# Install client deps  
cd client && npm install && cd ..

# Build client
npm run build

# Start server (serves built client + API proxy)
npm start
```

## Architecture

```
render.com (free web service)
├── server/index.js     ← Express server + Anthropic proxy
│   ├── POST /api/claude  ← Proxies to Anthropic (key stays server-side)
│   ├── GET  /api/health  ← Health check
│   └── GET  *            ← Serves React build
└── client/             ← React app (built to client/build/)
    ├── src/App.jsx       ← Full racing analyst UI
    └── src/index.js      ← Entry point
```

## ⚠️ Disclaimer
For entertainment purposes only. Not financial or betting advice. Please gamble responsibly. BeGambleAware.org
