import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/lib/accounts.ts";
import { TelegramBot } from "../src/lib/telegram.ts";
import { createNotifier } from "../src/lib/alerts.ts";
import type { EngineEvent } from "@weft/engine";

function setup() {
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-tg-")), "a.db"));
  const sent: { chat_id: string; text: string }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "sendMessage") sent.push(body);
    const result = method === "getMe" ? { username: "weft_alerts_bot" } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as never;
  const bot = new TelegramBot("123:abc", accounts, { fetch: fetchImpl });
  return { accounts, bot, sent };
}
const msg = (id: number, chat: number, text: string) => ({ update_id: id, message: { chat: { id: chat, type: "private" }, from: { username: "leo" }, text } });

describe("per-user Telegram alerts", () => {
  it("links a chat with a one-time code from the deep link", async () => {
    const { accounts, bot, sent } = setup();
    const url = await bot.linkUrl("did:privy:u1");
    expect(url).toMatch(/^https:\/\/t\.me\/weft_alerts_bot\?start=[\w-]{16}$/);
    const code = url.split("start=")[1]!;
    await bot.handle([msg(1, 555, `/start ${code}`)]);
    expect(accounts.telegramLink("did:privy:u1")).toMatchObject({ chatId: "555", username: "leo" });
    expect(sent.at(-1)!.text).toMatch(/^Connected/);
    // codes are single use
    await bot.handle([msg(2, 777, `/start ${code}`)]);
    expect(sent.at(-1)!.text).toMatch(/expired/);
    expect(accounts.telegramLink("did:privy:u1")!.chatId).toBe("555");
  });

  it("/stop unlinks, and alerts go only to the run owner's chat", async () => {
    const { accounts, bot, sent } = setup();
    accounts.setTelegramLink("u1", "555", null);
    accounts.setDeploymentOwner("dep1", "u1");
    let listener: (e: EngineEvent) => void = () => {};
    const notifier = createNotifier({ subscribe: (l) => ((listener = l), () => {}) }, [], {
      strategyName: async () => "BTC momentum",
      perUser: { ownerOf: (id) => accounts.deploymentOwner(id), send: (u, a) => bot.sendToUser(u, `◆ ${a.strategyName}\n${a.text}`) },
    });
    listener({ id: "e1", deploymentId: "dep1", ts: 1, type: "notify", message: "BTC entry conditions met", data: { actionId: "a1", channel: "telegram" } });
    listener({ id: "e2", deploymentId: "dep-other", ts: 1, type: "notify", message: "not yours", data: { actionId: "a1" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([{ chat_id: "555", text: "◆ BTC momentum\nBTC entry conditions met", disable_web_page_preview: true }]);
    await bot.handle([msg(3, 555, "/stop")]);
    expect(accounts.telegramLink("u1")).toBeNull();
    notifier.unsubscribe();
  });
});
