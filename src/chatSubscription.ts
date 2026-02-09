import { promises as fs } from "fs";
import path from "path";

interface StoredChatConfig {
  chatId: string;
}

export class ChatSubscriptionStore {
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(process.cwd(), "data", "chat-subscription.json");
  }

  async getChatId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StoredChatConfig>;
      if (typeof parsed.chatId !== "string" || !parsed.chatId.trim()) {
        return null;
      }
      return parsed.chatId.trim();
    } catch {
      return null;
    }
  }

  async setChatId(chatId: string): Promise<void> {
    const normalized = chatId.trim();
    if (!normalized) {
      throw new Error("chatId must not be empty");
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({ chatId: normalized }, null, 2), "utf-8");
  }

  async clearChatId(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // Ignore if file does not exist.
    }
  }
}
