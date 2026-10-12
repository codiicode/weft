import type { Engine, EngineEvent } from "@weft/engine";

/**
 * Delivers strategy alerts (notify actions, and optionally fills / kills) to
 * Telegram and/or a generic webhook. This is what powers alerts-only
 * strategies: the graph runs, and instead of trading it tells you.
 *
 * Configure with env vars:
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   → Telegram Bot API
 *   WEFT_ALERT_WEBHOOK_URL                  → POST JSON (Discord/Slack/Zapier/…)
 *   WEFT_ALERT_FILLS=1                      → also alert on fills and liquidations
 */

export interface Alert {
  deploymentId: string;
  strategyName: string;
  kind: "notify" | "fill" | "status";
  channel?: string;
  text: string;
  ts: number;
}

export interface AlertSink {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

type Fetch = typeof fetch;

export function telegramSink(token: string, chatId: string, fetchImpl: Fetch = fetch): AlertSink {
  return {
    name: "telegram",
    async send(a) {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `◆ ${a.strategyName}\n${a.text}`, disable_web_page_preview: true }),
      });
      if (!res.ok) throw new Error(`telegram ${res.status}`);
    },
  };
}

export function webhookSink(url: string, fetchImpl: Fetch = fetch): AlertSink {
  return {
    name: "webhook",
    async send(a) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `content` makes it render in Discord, `text` in Slack; the rest is structured.
        body: JSON.stringify({ ...a, message: a.text, content: `**${a.strategyName}**: ${a.text}`, text: `${a.strategyName}: ${a.text}` }),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
    },
  };
}

export function sinksFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): AlertSink[] {
  const sinks: AlertSink[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) sinks.push(telegramSink(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, fetchImpl));
  if (env.WEFT_ALERT_WEBHOOK_URL) sinks.push(webhookSink(env.WEFT_ALERT_WEBHOOK_URL, fetchImpl));
  return sinks;
}

export interface NotifierOptions {
  includeFills?: boolean;
  /** Max alerts per deployment per minute (protects chats from a runaway strategy). */
  perMinute?: number;
  strategyName: (deploymentId: string) => Promise<string>;
  log?: (msg: string) => void;
  now?: () => number;
  /** Also deliver each alert to the run owner's own chat (per-user Telegram). */
  perUser?: { ownerOf: (deploymentId: string) => string | null; send: (userId: string, alert: Alert) => Promise<boolean> };
}

/** Maps an engine event to an alert, or null when it shouldn't alert. */
export function toAlert(e: EngineEvent, includeFills: boolean): Omit<Alert, "strategyName"> | null {
  const data = (e.data ?? {}) as { actionId?: string; channel?: string; funding?: unknown; liquidation?: unknown };
  if (e.type === "notify" && data.actionId && !data.funding) {
    return { deploymentId: e.deploymentId, kind: "notify", channel: data.channel, text: e.message, ts: e.ts };
  }
  if (includeFills && e.type === "fill") return { deploymentId: e.deploymentId, kind: "fill", text: e.message, ts: e.ts };
  if (includeFills && e.type === "warning" && data.liquidation) return { deploymentId: e.deploymentId, kind: "fill", text: e.message, ts: e.ts };
  if (e.type === "status" && /kill/i.test(e.message)) return { deploymentId: e.deploymentId, kind: "status", text: e.message, ts: e.ts };
  return null;
}

export function createNotifier(engine: Pick<Engine, "subscribe">, sinks: AlertSink[], opts: NotifierOptions) {
  const perMinute = opts.perMinute ?? 20;
  const now = opts.now ?? Date.now;
  const seen = new Set<string>();
  const windows = new Map<string, number[]>();
  const sent: Alert[] = [];
  const log = opts.log ?? (() => {});

  const deliver = async (a: Alert) => {
    for (const sink of sinks) {
      try {
        await sink.send(a);
      } catch (err) {
        // one retry, then give up quietly: alerts must never break the engine
        try {
          await sink.send(a);
        } catch {
          log(`alert via ${sink.name} failed: ${(err as Error).message}`);
        }
      }
    }
    const owner = opts.perUser && a.deploymentId !== "test" ? opts.perUser.ownerOf(a.deploymentId) : null;
    if (owner) {
      try {
        await opts.perUser!.send(owner, a);
      } catch (err) {
        log(`alert to user ${owner} failed: ${(err as Error).message}`);
      }
    }
    sent.push(a);
    if (sent.length > 100) sent.shift();
  };

  const unsubscribe = engine.subscribe((e) => {
    const base = toAlert(e, !!opts.includeFills);
    if (!base || seen.has(e.id)) return;
    seen.add(e.id);
    if (seen.size > 5_000) seen.clear();
    const t = now();
    const w = (windows.get(e.deploymentId) ?? []).filter((x) => t - x < 60_000);
    if (w.length >= perMinute) return;
    w.push(t);
    windows.set(e.deploymentId, w);
    void opts
      .strategyName(e.deploymentId)
      .catch(() => e.deploymentId)
      .then((strategyName) => deliver({ ...base, strategyName }));
  });

  return {
    unsubscribe,
    sinks: sinks.map((s) => s.name),
    recent: () => [...sent].reverse(),
    test: (text = "Test alert from Weft. Alerts are working.") =>
      deliver({ deploymentId: "test", strategyName: "Weft", kind: "status", text, ts: now() }),
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
