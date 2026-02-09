import { config } from "./config";
import { TransferMonitor } from "./monitor";
import { TelegramService } from "./telegram";
import { ZigWebSocketClient } from "./websocket";

async function main(): Promise<void> {
  const telegram = new TelegramService(config.telegramToken, config.telegramChatId);
  const monitor = new TransferMonitor(config, telegram);

  const wsClient = new ZigWebSocketClient({
    url: config.wsUrl,
    onMessage: (raw) => {
      void monitor.handleRawMessage(raw);
    },
    onOpen: () => console.log("[app] WebSocket stream active"),
    onClose: () => console.log("[app] Waiting for reconnect..."),
    onError: (err) => console.error("[app] WebSocket error:", err.message)
  });

  const shutdown = (): void => {
    console.log("[app] Graceful shutdown requested");
    wsClient.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  wsClient.connect();
  console.log("[app] ZigChain transfer monitor started");
}

process.on("unhandledRejection", (reason) => {
  console.error("[app] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[app] Uncaught exception:", err);
});

void main().catch((err) => {
  console.error("[app] Fatal error:", err);
  process.exit(1);
});
