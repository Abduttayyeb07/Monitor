import { AppConfig } from "./config";
import { TelegramNotifier } from "./telegram";

interface TxSendEvent {
  sender: string;
  recipient: string;
  amount: string;
  denom: string;
  txhash: string;
}

interface NormalizedTransfer {
  sender: string;
  recipient: string;
  amountUzig: bigint;
  denom: string;
  txhash: string;
}

interface TxContext {
  eventType: string | null;
  contractAddress: string | null;
  action: string | null;
  offerAsset: string | null;
  askAsset: string | null;
  offerAmount: string | null;
  returnAmount: string | null;
}

export class TransferMonitor {
  private readonly seenTxHashes = new Set<string>();
  private readonly txOrder: string[] = [];
  private nonEventMessageCount = 0;
  private readonly txContextCache = new Map<string, TxContext | null>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly notifier: TelegramNotifier
  ) {}

  async handleRawMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[monitor] Ignoring non-JSON message");
      return;
    }

    const events = this.extractTxSendEvents(parsed);
    if (events.length === 0) {
      this.logNonEventMessage(parsed);
      return;
    }

    const txBuckets = new Map<string, NormalizedTransfer[]>();
    for (const event of events) {
      const normalized = this.normalizeTransfer(event);
      if (!normalized || this.seenTxHashes.has(normalized.txhash)) {
        continue;
      }

      const existing = txBuckets.get(normalized.txhash);
      if (existing) {
        existing.push(normalized);
      } else {
        txBuckets.set(normalized.txhash, [normalized]);
      }
    }

    for (const [txHash, transfers] of txBuckets.entries()) {
      const txContext = await this.getTxContext(txHash);
      for (const normalized of transfers) {
        const senderMatch = this.cfg.monitoredWallets.has(normalized.sender);
        const recipientMatch = this.cfg.monitoredWallets.has(normalized.recipient);

        if (!senderMatch && !recipientMatch) {
          continue;
        }

        if (normalized.denom !== "uzig") {
          continue;
        }

        if (normalized.amountUzig < this.cfg.minAmountUzig) {
          continue;
        }

        const amountZig = this.formatZigAmount(normalized.amountUzig);

        if (senderMatch) {
          await this.sendAlert(normalized, normalized.sender, "Sent", amountZig, txContext);
        }

        if (recipientMatch) {
          await this.sendAlert(normalized, normalized.recipient, "Received", amountZig, txContext);
        }

        console.log(
          `[monitor] Large transfer detected tx=${normalized.txhash} sender=${normalized.sender} recipient=${normalized.recipient} amountUZIG=${normalized.amountUzig}`
        );
      }

      this.markSeen(txHash);
    }
  }

  private async sendAlert(
    transfer: NormalizedTransfer,
    wallet: string,
    direction: "Sent" | "Received",
    amountZig: string,
    txContext: TxContext | null
  ): Promise<void> {
    try {
      await this.notifier.sendLargeTransferAlert({
        wallet,
        direction,
        amountZig,
        amountUzig: transfer.amountUzig.toString(),
        denom: transfer.denom,
        txHash: transfer.txhash,
        sender: transfer.sender,
        recipient: transfer.recipient,
        eventType: txContext?.eventType || "wasm",
        contractAddress: txContext?.contractAddress || transfer.recipient,
        action: txContext?.action || null,
        offerAsset: txContext?.offerAsset || null,
        askAsset: txContext?.askAsset || null,
        offerAmount: txContext?.offerAmount || null,
        returnAmount: txContext?.returnAmount || null
      });
      console.log(`[telegram] Alert sent for ${transfer.txhash} (${direction.toLowerCase()})`);
    } catch (err) {
      console.error("[telegram] Failed to send alert:", err);
    }
  }

  private async getTxContext(txHash: string): Promise<TxContext | null> {
    if (this.txContextCache.has(txHash)) {
      return this.txContextCache.get(txHash) || null;
    }

    const url = `${this.cfg.lcdUrl.replace(/\/+$/, "")}/cosmos/tx/v1beta1/txs/${txHash}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(8_000)
        });
        if (!response.ok) {
          if (attempt === 3) {
            console.warn(`[monitor] Failed to fetch tx context for ${txHash}: HTTP ${response.status}`);
          }
        } else {
          const payload = (await response.json()) as unknown;
          const context = this.extractTxContextFromLcd(payload);
          if (context) {
            this.txContextCache.set(txHash, context);
            return context;
          }
        }
      } catch (err) {
        if (attempt === 3) {
          console.warn(`[monitor] Failed to fetch tx context for ${txHash}:`, err);
        }
      }

      if (attempt < 3) {
        await this.sleep(1200);
      }
    }

    return null;
  }

  private extractTxContextFromLcd(payload: unknown): TxContext | null {
    const root = this.asRecord(payload);
    if (!root) {
      return null;
    }

    const txResponse = this.asRecord(root.tx_response);
    const fromLogs = this.extractWasmContextFromLogs(txResponse?.logs);
    if (fromLogs) {
      return fromLogs;
    }

    return this.extractWasmContextFromEventArray(txResponse?.events);
  }

  private extractWasmContextFromLogs(logs: unknown): TxContext | null {
    if (!Array.isArray(logs)) {
      return null;
    }

    for (const logRaw of logs) {
      const log = this.asRecord(logRaw);
      if (!log || !Array.isArray(log.events)) {
        continue;
      }

      const ctx = this.extractWasmContextFromEventArray(log.events);
      if (ctx) {
        return ctx;
      }
    }

    return null;
  }

  private extractWasmContextFromEventArray(eventsRaw: unknown): TxContext | null {
    if (!Array.isArray(eventsRaw)) {
      return null;
    }

    for (const eventRaw of eventsRaw) {
      const event = this.asRecord(eventRaw);
      if (!event || String(event.type || "").toLowerCase() !== "wasm") {
        continue;
      }

      const attrs = Array.isArray(event.attributes) ? event.attributes : [];
      const values = new Map<string, string>();
      for (const attrRaw of attrs) {
        const attr = this.asRecord(attrRaw);
        if (!attr) {
          continue;
        }

        const key = String(attr.key || "").trim();
        const value = String(attr.value || "").trim();
        if (key && value) {
          values.set(key, value);
        }
      }

      return {
        eventType: "wasm",
        contractAddress: values.get("_contract_address") || null,
        action: values.get("action") || null,
        offerAsset: values.get("offer_asset") || null,
        askAsset: values.get("ask_asset") || null,
        offerAmount: values.get("offer_amount") || null,
        returnAmount: values.get("return_amount") || null
      };
    }

    return null;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private markSeen(txHash: string): void {
    this.seenTxHashes.add(txHash);
    this.txOrder.push(txHash);

    if (this.txOrder.length > this.cfg.maxSeenTxHashes) {
      const oldest = this.txOrder.shift();
      if (oldest) {
        this.seenTxHashes.delete(oldest);
      }
    }
  }

  private normalizeTransfer(event: TxSendEvent): NormalizedTransfer | null {
    const sender = String(event.sender || "").trim();
    const recipient = String(event.recipient || "").trim();
    const denom = String(event.denom || "").trim().toLowerCase();
    const txhash = String(event.txhash || "").trim();

    if (!sender || !recipient || !denom || !txhash) {
      return null;
    }

    const amountRaw = String(event.amount ?? "").trim();
    const amountUzig = this.parseAmountToUzig(amountRaw, denom);

    if (amountUzig === null || amountUzig <= 0n) {
      return null;
    }

    return {
      sender,
      recipient,
      amountUzig,
      denom,
      txhash
    };
  }

  private parseAmountToUzig(amountRaw: string, denom: string): bigint | null {
    if (/^\d+$/.test(amountRaw)) {
      return BigInt(amountRaw);
    }

    const lower = amountRaw.toLowerCase();
    if (denom && lower.endsWith(denom)) {
      const numericPart = lower.slice(0, -denom.length);
      if (/^\d+$/.test(numericPart)) {
        return BigInt(numericPart);
      }
    }

    return null;
  }

  private formatZigAmount(amountUzig: bigint): string {
    const whole = amountUzig / this.cfg.zigDecimals;
    const fraction = amountUzig % this.cfg.zigDecimals;

    const wholeStr = this.addThousandsSeparators(whole.toString());
    if (fraction === 0n) {
      return wholeStr;
    }

    const fractionStr = fraction.toString().padStart(6, "0").replace(/0+$/, "");
    return `${wholeStr}.${fractionStr}`;
  }

  private addThousandsSeparators(numStr: string): string {
    return numStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  private extractTxSendEvents(payload: unknown): TxSendEvent[] {
    const found: TxSendEvent[] = [];
    this.walk(payload, (value) => {
      if (this.isTxSendEvent(value)) {
        found.push(value);
      }
    });

    if (found.length > 0) {
      return found;
    }

    const cosmosStyle = this.extractFromCosmosEventStyle(payload);
    if (cosmosStyle.length > 0) {
      return cosmosStyle;
    }

    const tendermintEvents = this.extractFromTendermintEventArray(payload);
    if (tendermintEvents.length > 0) {
      return tendermintEvents;
    }

    return this.extractFromMessageBodies(payload);
  }

  private extractFromCosmosEventStyle(payload: unknown): TxSendEvent[] {
    const obj = this.asRecord(payload);
    if (!obj) {
      return [];
    }

    const result = this.asRecord(obj.result);
    const events = this.asRecord(result?.events);

    const senders = this.stringArray(events?.["transfer.sender"]);
    const recipients = this.stringArray(events?.["transfer.recipient"]);
    const amounts = this.stringArray(events?.["transfer.amount"]);
    const txhash = this.firstArrayValue(events?.["tx.hash"]) || this.firstArrayValue(events?.["tx.hashes"]);

    if (!txhash || senders.length === 0 || recipients.length === 0 || amounts.length === 0) {
      return [];
    }

    const transfers: TxSendEvent[] = [];
    const count = Math.max(senders.length, recipients.length, amounts.length);
    for (let i = 0; i < count; i += 1) {
      const sender = (senders[i] || senders[0] || "").trim();
      const recipient = (recipients[i] || recipients[0] || "").trim();
      const amount = (amounts[i] || amounts[0] || "").trim();
      if (!sender || !recipient || !amount) {
        continue;
      }

      const match = amount.toLowerCase().match(/^(\d+)([a-z0-9]+)$/);
      if (!match) {
        continue;
      }

      transfers.push({
        sender,
        recipient,
        amount: match[1],
        denom: match[2],
        txhash
      });
    }

    return transfers;
  }

  private extractFromTendermintEventArray(payload: unknown): TxSendEvent[] {
    const root = this.asRecord(payload);
    if (!root) {
      return [];
    }

    const txHash = this.extractTxHash(payload);
    if (!txHash) {
      return [];
    }

    const eventsCandidates: unknown[] = [];
    const result = this.asRecord(root.result);
    const data = this.asRecord(result?.data);
    const value = this.asRecord(data?.value);
    const txResultContainer = this.asRecord(value?.TxResult);
    const txResult = this.asRecord(txResultContainer?.result);
    eventsCandidates.push(txResult?.events, result?.events);

    const allEvents: Record<string, unknown>[] = [];
    for (const candidate of eventsCandidates) {
      if (Array.isArray(candidate)) {
        for (const event of candidate) {
          const obj = this.asRecord(event);
          if (obj) {
            allEvents.push(obj);
          }
        }
      }
    }

    if (allEvents.length === 0) {
      return [];
    }

    const transfers: TxSendEvent[] = [];
    for (const event of allEvents) {
      if (String(event.type || "").toLowerCase() !== "transfer") {
        continue;
      }

      const attrs = Array.isArray(event.attributes) ? event.attributes : [];
      const senders: string[] = [];
      const recipients: string[] = [];
      const amounts: string[] = [];

      for (const attrRaw of attrs) {
        const attr = this.asRecord(attrRaw);
        if (!attr) {
          continue;
        }

        const key = this.decodeMaybeBase64(String(attr.key ?? ""));
        const valueRaw = this.decodeMaybeBase64(String(attr.value ?? ""));
        if (key === "sender") {
          senders.push(valueRaw);
        } else if (key === "recipient") {
          recipients.push(valueRaw);
        } else if (key === "amount") {
          amounts.push(valueRaw);
        }
      }

      const count = Math.max(senders.length, recipients.length, amounts.length);
      for (let i = 0; i < count; i += 1) {
        const sender = (senders[i] || senders[0] || "").trim();
        const recipient = (recipients[i] || recipients[0] || "").trim();
        const amountStr = (amounts[i] || amounts[0] || "").trim().toLowerCase();
        if (!sender || !recipient || !amountStr) {
          continue;
        }

        for (const coin of this.parseCoins(amountStr)) {
          transfers.push({
            sender,
            recipient,
            amount: coin.amount,
            denom: coin.denom,
            txhash: txHash
          });
        }
      }
    }

    return transfers;
  }

  private extractFromMessageBodies(payload: unknown): TxSendEvent[] {
    const txHash = this.extractTxHash(payload);
    if (!txHash) {
      return [];
    }

    const transfers: TxSendEvent[] = [];
    this.walk(payload, (value) => {
      const obj = this.asRecord(value);
      if (!obj) {
        return;
      }

      const msgType = String(obj["@type"] || "");
      if (
        msgType === "/cosmwasm.wasm.v1.MsgExecuteContract" &&
        typeof obj.sender === "string" &&
        typeof obj.contract === "string" &&
        Array.isArray(obj.funds)
      ) {
        for (const fundRaw of obj.funds) {
          const fund = this.asRecord(fundRaw);
          if (!fund) {
            continue;
          }
          const denom = String(fund.denom || "").trim().toLowerCase();
          const amount = String(fund.amount || "").trim();
          if (!denom || !amount) {
            continue;
          }
          transfers.push({
            sender: String(obj.sender),
            recipient: String(obj.contract),
            amount,
            denom,
            txhash: txHash
          });
        }
      }

      if (
        msgType === "/cosmos.bank.v1beta1.MsgSend" &&
        typeof obj.from_address === "string" &&
        typeof obj.to_address === "string" &&
        Array.isArray(obj.amount)
      ) {
        for (const coinRaw of obj.amount) {
          const coin = this.asRecord(coinRaw);
          if (!coin) {
            continue;
          }
          const denom = String(coin.denom || "").trim().toLowerCase();
          const amount = String(coin.amount || "").trim();
          if (!denom || !amount) {
            continue;
          }
          transfers.push({
            sender: String(obj.from_address),
            recipient: String(obj.to_address),
            amount,
            denom,
            txhash: txHash
          });
        }
      }
    });

    return transfers;
  }

  private extractTxHash(payload: unknown): string | null {
    const root = this.asRecord(payload);
    if (!root) {
      return null;
    }

    const direct = typeof root.txhash === "string" ? root.txhash : null;
    if (direct) {
      return direct;
    }

    const result = this.asRecord(root.result);
    const events = this.asRecord(result?.events);
    const eventHash = this.firstArrayValue(events?.["tx.hash"]) || this.firstArrayValue(events?.["tx.hashes"]);
    if (eventHash) {
      return eventHash;
    }

    const data = this.asRecord(result?.data);
    const value = this.asRecord(data?.value);
    const txResultContainer = this.asRecord(value?.TxResult);
    const txResult = this.asRecord(txResultContainer?.result);
    if (typeof txResult?.hash === "string") {
      return txResult.hash;
    }

    return null;
  }

  private parseCoins(raw: string): Array<{ amount: string; denom: string }> {
    const coins: Array<{ amount: string; denom: string }> = [];
    const normalized = raw.toLowerCase();
    const regex = /(\d+)([a-z0-9/._-]+)/g;
    let match: RegExpExecArray | null = regex.exec(normalized);
    while (match) {
      coins.push({ amount: match[1], denom: match[2] });
      match = regex.exec(normalized);
    }
    return coins;
  }

  private decodeMaybeBase64(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      return "";
    }

    if (/^[a-z0-9/._:-]+$/i.test(trimmed)) {
      return trimmed;
    }

    if (!/^[a-z0-9+/=]+$/i.test(trimmed) || trimmed.length % 4 !== 0) {
      return trimmed;
    }

    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf-8").trim();
      if (!decoded) {
        return trimmed;
      }
      return /^[\x20-\x7e]+$/.test(decoded) ? decoded : trimmed;
    } catch {
      return trimmed;
    }
  }

  private isTxSendEvent(value: unknown): value is TxSendEvent {
    const obj = this.asRecord(value);
    if (!obj) {
      return false;
    }

    return (
      typeof obj.sender === "string" &&
      typeof obj.recipient === "string" &&
      (typeof obj.amount === "string" || typeof obj.amount === "number") &&
      typeof obj.denom === "string" &&
      typeof obj.txhash === "string"
    );
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private firstArrayValue(value: unknown): string | null {
    if (!Array.isArray(value) || value.length === 0) {
      return null;
    }

    const first = value[0];
    return typeof first === "string" ? first : null;
  }

  private stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === "string");
  }

  private walk(value: unknown, visit: (value: unknown) => void): void {
    visit(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        this.walk(item, visit);
      }
      return;
    }

    const obj = this.asRecord(value);
    if (!obj) {
      return;
    }

    for (const nested of Object.values(obj)) {
      this.walk(nested, visit);
    }
  }

  private logNonEventMessage(payload: unknown): void {
    const obj = this.asRecord(payload);
    if (!obj) {
      return;
    }

    const rpcError = this.asRecord(obj.error);
    if (rpcError) {
      console.error("[ws] Subscription RPC error:", JSON.stringify(rpcError));
      return;
    }

    const result = this.asRecord(obj.result);
    if (result?.query && typeof result.query === "string") {
      console.log(`[ws] Subscription ack received: query=${result.query}`);
      return;
    }

    this.nonEventMessageCount += 1;
    if (this.nonEventMessageCount % 50 === 0) {
      const json = JSON.stringify(payload);
      const preview = json.length > 280 ? `${json.slice(0, 280)}...` : json;
      console.log(`[ws] Non-event payload x${this.nonEventMessageCount}: ${preview}`);
    }
  }
}
