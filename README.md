# ZigChain Telegram Transfer Monitor

Production-ready TypeScript Telegram bot that monitors ZigChain wallet transfers in real time and sends alerts to Telegram.

## Features
- Monitors ZigChain transactions over WebSocket
- Filters `uzig` transfers for monitored wallets
- Threshold-based alerting (`MIN_AMOUNT_ZIG`)
- Telegram alerts with tx links
- Auto-reconnect with exponential backoff
- Tx hash deduplication
- Telegram group self-subscription commands:
  - `/start`
  - `/subscribe`
  - `/unsubscribe`
  - `/chatid`
- Docker support

## Project Structure
- `src/config.ts`
- `src/telegram.ts`
- `src/websocket.ts`
- `src/monitor.ts`
- `src/index.ts`
- `src/chatSubscription.ts`

## Requirements
- Node.js 18+
- Telegram bot token (from BotFather)

## Environment
Create `.env`:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=optional_fallback_chat_id
WS_URL=wss://zigchain-mainnet.zigscan.net/websocket
MIN_AMOUNT_ZIG=50000
```

Notes:
- `1 ZIG = 1,000,000 uzig`
- `TELEGRAM_CHAT_ID` is optional. You can set alert destination dynamically with `/subscribe`.

## Install and Run (Local)
```bash
npm install
npm run build
npm start
```

## Telegram Setup
1. Start bot process.
2. Add bot to your Telegram group.
3. In group, send `/subscribe`.
4. Verify with `/chatid`.

If commands do not respond in group, disable BotFather privacy mode or make the bot an admin.

## Docker
Build image:
```bash
docker build -t zig-monitor .
```

Run container:
```bash
docker run -d --name zig-monitor --env-file .env -v ${PWD}/data:/app/data zig-monitor
```

Windows PowerShell path example:
```powershell
docker run -d --name zig-monitor --env-file .env -v C:\Users\abdut\OneDrive\Desktop\Monitor\data:/app/data zig-monitor
```

`/app/data` stores Telegram subscription state (`chat-subscription.json`) so your subscribed chat ID persists across restarts.

## Logs
View logs:
```bash
docker logs -f zig-monitor
```

## Common Issues
- `failed to parse query ... EOF` for `tx.send`: endpoint does not support that query; bot uses Tendermint tx subscription.
- No alerts: confirm monitored wallets in `src/config.ts`, threshold in `.env`, and active chat via `/chatid`.
- Telegram errors like `ECONNRESET`: usually transient network issues; bot keeps running.
