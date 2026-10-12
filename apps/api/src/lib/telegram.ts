import { randomBytes } from "node:crypto";
import type { Accounts } from "./accounts.ts";

/**
 * Per-user Telegram alerts through one Weft bot.
 *
 * Linking: the app asks for a one-time code and opens t.me/<bot>?start=<code>.
 * Telegram sends "/start <code>" to the bot; we match the code to the user and
 * remember the chat. "/stop" in the chat unlinks it. Updates arrive by long
 * polling, so no public webhook URL is needed.
 */

type Fetch = typeof fetch;

interface Update {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { username?: string }; text?: string };
}

const CODE_TTL_MS = 15 * 60_000;

export class TelegramBot {
  private readonly token: string;
  private readonly accounts: Accounts;
  private readonly fetchImpl: Fetch;
  private username: string | null;
  private offset = 0;
  private running = false;
  private log: (m: string) => void;

  constructor(token: string, accounts: Accounts, opts: { username?: string; fetch?: Fetch; log?: (m: string) => void } = {}) {
    this.token = token;
    this.accounts = accounts;
    this.fetchImpl = opts.fetch ?? fetch;
    this.username = opts.username?.replace(/^@/, "") || null;
    this.log = opts.log ?? (() => {});
  }

  private async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async botUsername(): Promise<string> {
    if (!this.username) this.username = (await this.call<{ username: string }>("getMe")).username;
    return this.username;
  }

  /** A t.me deep link that links the chat it is opened in to this user. */
  async linkUrl(userId: string): Promise<string> {
    const code = randomBytes(12).toString("base64url");
    this.accounts.createTelegramCode(userId, code, CODE_TTL_MS);
    return `https://t.me/${await this.botUsername()}?start=${code}`;
  }

  async sendTo(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  }

  /** Sends to the user's linked chat, if any. Returns whether a chat was linked. */
  async sendToUser(userId: string, text: string): Promise<boolean> {
    const link = this.accounts.telegramLink(userId);
    if (!link) return false;
    try {
      await this.sendTo(link.chatId, text);
    } catch (e) {
      // The user blocked the bot or deleted the chat: forget it.
      if (/blocked|chat not found|deactivated/i.test((e as Error).message)) this.accounts.removeTelegramChat(link.chatId);
      throw e;
    }
    return true;
  }

  /** Handles one batch of updates (exposed for tests). */
  async handle(updates: Update[]): Promise<void> {
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m?.text || m.chat.type !== "private") continue;
      const chatId = String(m.chat.id);
      const [cmd, arg] = m.text.trim().split(/\s+/, 2);
      if (cmd === "/start" && arg) {
        const userId = this.accounts.consumeTelegramCode(arg);
        if (userId) {
          this.accounts.setTelegramLink(userId, chatId, m.from?.username ?? null);
          await this.sendTo(chatId, "Connected. Alerts from your Weft runs will arrive here. Send /stop to turn them off.").catch(() => {});
        } else {
          await this.sendTo(chatId, "That link has expired. Open Settings in Weft and connect Telegram again.").catch(() => {});
        }
      } else if (cmd === "/stop") {
        this.accounts.removeTelegramChat(chatId);
        await this.sendTo(chatId, "Alerts are off. Connect again from Settings in Weft any time.").catch(() => {});
      } else if (cmd === "/start") {
        await this.sendTo(chatId, "Hi. Connect this chat from Settings in Weft to get alerts from your runs.").catch(() => {});
      }
    }
  }

  /** Long-polls getUpdates until stop() is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          const updates = await this.call<Update[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] });
          await this.handle(updates);
        } catch (e) {
          this.log(`telegram polling: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    })();
  }

  stop(): void {
    this.running = false;
  }
}
