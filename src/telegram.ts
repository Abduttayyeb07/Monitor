import TelegramBot from "node-telegram-bot-api";
import { ChatSubscriptionStore } from "./chatSubscription";

export interface TelegramNotifier {
  sendLargeTransferAlert(params: {
    wallet: string;
    direction: "Sent" | "Received";
    amountZig: string;
    amountUzig: string;
    denom: string;
    txHash: string;
    sender: string;
    recipient: string;
    contractAddress?: string | null;
    action?: string | null;
    offerAsset?: string | null;
    askAsset?: string | null;
    offerAmount?: string | null;
    returnAmount?: string | null;
    eventType?: string | null;
  }): Promise<void>;
}

export class TelegramService implements TelegramNotifier {
  private readonly bot: TelegramBot;
  private readonly store = new ChatSubscriptionStore();
  private activeChatId: string | null;

  constructor(
    private readonly token: string,
    chatId: string | null
  ) {
    this.activeChatId = chatId;
    this.bot = new TelegramBot(this.token, { polling: true });
    this.registerCommands();
    void this.loadStoredChatId();
  }

  async sendLargeTransferAlert(params: {
    wallet: string;
    direction: "Sent" | "Received";
    amountZig: string;
    amountUzig: string;
    denom: string;
    txHash: string;
    sender: string;
    recipient: string;
    contractAddress?: string | null;
    action?: string | null;
    offerAsset?: string | null;
    askAsset?: string | null;
    offerAmount?: string | null;
    returnAmount?: string | null;
    eventType?: string | null;
  }): Promise<void> {
    const destinationChatId = this.activeChatId;
    if (!destinationChatId) {
      console.warn("[telegram] No subscribed chat ID set. Use /subscribe in your target group.");
      return;
    }

    const text = [
      "Large Transfer Detected",
      "",
      `Wallet: ${params.wallet}`,
      `Direction: ${params.direction}`,
      "",
      `Sender: ${params.sender}`,
      `Recipient: ${params.recipient}`,
      `Contract (To): ${params.contractAddress || params.recipient}`,
      "",
      `Amount: ${params.amountZig} ZIG (${params.amountUzig} ${params.denom})`,
      `Type: ${params.eventType || "wasm"}`,
      `Action: ${params.action || "n/a"}`,
      "",
      `Ask Asset (Denom): ${params.askAsset || params.denom}`,
      `Offer: ${params.offerAmount || "n/a"} ${params.offerAsset || "n/a"}`,
      `Return: ${params.returnAmount || "n/a"}`,
      "",
      `Tx: https://www.zigscan.org/tx/${params.txHash}`
    ].join("\n");

    await this.bot.sendMessage(destinationChatId, text, {
      disable_web_page_preview: true
    });
  }

  private registerCommands(): void {
    this.bot.onText(/^\/start(?:\s|$)/, (msg) => {
      void this.handleStartCommand(msg);
    });
    this.bot.onText(/^\/subscribe(?:@\w+)?(?:\s|$)/, (msg) => {
      void this.handleSubscribeCommand(msg);
    });
    this.bot.onText(/^\/unsubscribe(?:@\w+)?(?:\s|$)/, (msg) => {
      void this.handleUnsubscribeCommand(msg);
    });
    this.bot.onText(/^\/chatid(?:@\w+)?(?:\s|$)/, (msg) => {
      void this.handleChatIdCommand(msg);
    });

    this.bot.on("polling_error", (err) => {
      console.error("[telegram] Polling error:", err.message);
    });
  }

  private async handleStartCommand(msg: TelegramBot.Message): Promise<void> {
    try {
      await this.bot.sendMessage(
        msg.chat.id,
        [
          "ZigChain monitor is running.",
          "Use /subscribe in this chat to receive transfer alerts here.",
          "Use /chatid to view current subscription."
        ].join("\n")
      );
    } catch (err) {
      console.error("[telegram] Failed to process /start:", err);
    }
  }

  private async handleSubscribeCommand(msg: TelegramBot.Message): Promise<void> {
    try {
      const chatId = String(msg.chat.id);
      await this.store.setChatId(chatId);
      this.activeChatId = chatId;
      await this.bot.sendMessage(msg.chat.id, `Subscribed. Alerts will be sent to chat ID ${chatId}.`);
      console.log(`[telegram] Subscribed alert destination chat=${chatId}`);
    } catch (err) {
      console.error("[telegram] Failed to process /subscribe:", err);
    }
  }

  private async handleUnsubscribeCommand(msg: TelegramBot.Message): Promise<void> {
    try {
      await this.store.clearChatId();
      this.activeChatId = null;
      await this.bot.sendMessage(msg.chat.id, "Unsubscribed. Alerts are disabled until /subscribe is used.");
      console.log("[telegram] Cleared subscribed alert destination");
    } catch (err) {
      console.error("[telegram] Failed to process /unsubscribe:", err);
    }
  }

  private async handleChatIdCommand(msg: TelegramBot.Message): Promise<void> {
    try {
      const current = this.activeChatId ?? "none";
      await this.bot.sendMessage(
        msg.chat.id,
        `Current alert chat ID: ${current}\nThis chat ID: ${msg.chat.id}`
      );
    } catch (err) {
      console.error("[telegram] Failed to process /chatid:", err);
    }
  }

  private async loadStoredChatId(): Promise<void> {
    try {
      const stored = await this.store.getChatId();
      if (stored) {
        this.activeChatId = stored;
        console.log(`[telegram] Loaded subscribed chat ID ${stored}`);
        return;
      }

      if (this.activeChatId) {
        await this.store.setChatId(this.activeChatId);
        console.log(`[telegram] Initialized subscription from TELEGRAM_CHAT_ID=${this.activeChatId}`);
      }
    } catch (err) {
      console.error("[telegram] Failed loading/storing chat subscription:", err);
    }
  }
}
