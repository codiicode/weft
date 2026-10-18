"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth, shortAddress } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { PageHeader, Card, Btn } from "@/components/app/AppShell";

function Row({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-[14.5px] font-medium text-ink">{title}</div>
        {sub && <div className="mt-0.5 text-[13.5px] leading-relaxed text-muted">{sub}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

function Telegram() {
  const me = useApi(() => api.alertsMe(), []);
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const linked = me.data?.telegram;
  const refresh = me.refresh;

  // After opening the bot, poll until the chat is linked (up to two minutes).
  useEffect(() => {
    if (!waiting || linked) {
      if (linked) setWaiting(false);
      return;
    }
    const t = setInterval(() => void refresh(), 2500);
    const stop = setTimeout(() => setWaiting(false), 120_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [waiting, linked, refresh]);

  if (!me.data) return <Row title="Telegram" sub={me.error ? "Couldn’t load alert settings." : "Loading…"} />;
  if (!me.data.available) return <Row title="Telegram" sub="Telegram alerts aren’t set up on this server yet." />;

  return (
    <>
      <Row
        title="Telegram"
        sub={
          linked
            ? `Connected${linked.username ? ` as @${linked.username}` : ""}. Alerts from your runs arrive there.`
            : waiting
              ? "Press Start in Telegram, then come back here."
              : "Get a message when a strategy alerts, gets stopped, or needs your attention."
        }
      >
        {linked ? (
          <>
            <Btn
              variant="quiet"
              onClick={async () => {
                try {
                  await api.testMyAlert();
                  setMsg({ ok: true, text: "Test sent. Check Telegram." });
                } catch (e) {
                  setMsg({ ok: false, text: (e as Error).message });
                }
              }}
            >
              Send a test
            </Btn>
            <Btn
              variant="ghost"
              onClick={async () => {
                await api.unlinkTelegram();
                setMsg(null);
                await me.refresh();
              }}
            >
              Disconnect
            </Btn>
          </>
        ) : (
          <Btn
            disabled={waiting}
            onClick={async () => {
              setMsg(null);
              // Open the tab synchronously so pop-up blockers allow it, then point it at the bot.
              const tab = window.open("about:blank", "_blank");
              try {
                const { url } = await api.linkTelegram();
                if (tab) tab.location.href = url;
                else window.location.href = url;
                setWaiting(true);
              } catch (e) {
                tab?.close();
                setMsg({ ok: false, text: (e as Error).message });
              }
            }}
          >
            {waiting ? "Waiting for Telegram…" : "Connect Telegram"}
          </Btn>
        )}
      </Row>
      {msg && <p className={`px-5 pb-4 text-[13.5px] ${msg.ok ? "text-long" : "text-short"}`}>{msg.text}</p>}
    </>
  );
}

function Theme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => setTheme((document.documentElement.dataset.theme as "light" | "dark") || "light"), []);
  const set = (t: "light" | "dark") => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("theme", t);
    } catch {}
  };
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 rounded-[10px] bg-paper-2 p-0.5">
      {(["light", "dark"] as const).map((t) => (
        <button
          key={t}
          role="radio"
          aria-checked={theme === t}
          onClick={() => set(t)}
          className={`h-8 rounded-[8px] px-4 text-[13px] capitalize ${theme === t ? "bg-raised font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted hover:text-ink"}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

const MCP_URL = "https://weft.fi/mcp";

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-faint">{label}</span>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-[12.5px] text-muted hover:text-ink"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre rounded-[10px] border border-line bg-paper-2 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink-2">{code}</pre>
    </div>
  );
}

/** Use Weft from Claude, ChatGPT, Cursor…: the MCP address, and keys that let an assistant read your runs. */
function AiAssistants() {
  const keys = useApi(() => api.aiKeys(), []);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      setFresh((await api.createAiKey("AI assistant")).key);
      keys.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await api.deleteAiKey(id).catch(() => {});
    keys.refresh();
  };
  const key = fresh ?? "<your key>";
  return (
    <>
      <Row
        title="Use Weft from your AI assistant"
        sub={
          <>
            Claude, ChatGPT, Cursor and other assistants that speak MCP can search markets and draft strategies with Weft. Nothing trades from there: a draft opens here, where you read it and start it.
          </>
        }
      />
      <div className="space-y-4 px-5 pb-5">
        <Snippet label="Address" code={MCP_URL} />
        <p className="-mt-2 text-[12.5px] text-muted">In Claude or ChatGPT, add it as a custom connector.</p>
        <div className="rounded-[10px] border border-line px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13.5px] leading-relaxed text-muted">
              <span className="font-medium text-ink">Your runs too:</span> with a key, an assistant can also read your runs and their returns. It can’t start, change or stop anything.
            </div>
            <Btn variant="ghost" onClick={create} disabled={busy}>
              {busy ? "Creating…" : "Create a key"}
            </Btn>
          </div>
          {err && <p className="mt-2 text-[13px] text-short">{err}</p>}
          {fresh && (
            <div className="mt-3 space-y-3">
              <Snippet label="Your key: copy it now, it won’t be shown again" code={fresh} />
            </div>
          )}
          {!!keys.data?.keys.length && (
            <ul className="mt-3 divide-y divide-line border-t border-line text-[13.5px]">
              {keys.data.keys.map((k) => (
                <li key={k.id} className="flex items-center justify-between py-2">
                  <span className="text-ink-2">
                    {k.label} <span className="text-faint">· created {new Date(k.createdAt).toLocaleDateString()}</span>
                  </span>
                  <button onClick={() => remove(k.id)} className="text-muted hover:text-short">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Snippet label="Claude Code" code={`claude mcp add --transport http weft ${MCP_URL} --header "Authorization: Bearer ${key}"`} />
        <Snippet label="Cursor and others (mcp.json)" code={JSON.stringify({ mcpServers: { weft: { url: MCP_URL, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)} />
      </div>
    </>
  );
}

export default function SettingsPage() {
  const auth = useAuth();
  const live = useApi(auth.enabled && auth.authenticated ? () => api.liveStatus() : null, [auth.enabled, auth.authenticated]);
  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-[760px] space-y-8 px-5 pb-16 pt-6 lg:px-10">
        {auth.enabled && !auth.authenticated ? (
          <>
            <Card>
              <Row title="Not signed in" sub="Sign in to manage your account, alerts and live trading.">
                <Btn onClick={auth.login}>Sign in</Btn>
              </Row>
            </Card>
            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Appearance</h2>
              <Card>
                <Row title="Theme">
                  <Theme />
                </Row>
              </Card>
            </section>
          </>
        ) : (
          <>
            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Account</h2>
              <Card className="divide-y divide-line">
                <Row title={auth.enabled ? (auth.label ?? "Signed in") : "Local mode"} sub={auth.enabled ? "Signed in with Privy." : "This server runs without accounts."}>
                  {auth.enabled && (
                    <Btn variant="ghost" onClick={() => auth.logout()}>
                      Sign out
                    </Btn>
                  )}
                </Row>
                {auth.wallets.length > 0 && (
                  <Row
                    title="Wallets"
                    sub={
                      <span className="flex flex-col gap-0.5">
                        {auth.wallets.map((w) => (
                          <span key={w.address}>
                            <span className="font-mono text-[12.5px] text-ink-2">{shortAddress(w.address)}</span> · {w.chain === "ethereum" ? "Ethereum / Hyperliquid" : w.chain === "solana" ? "Solana" : "Other"}
                            {w.embedded ? " · created by Weft" : ""}
                          </span>
                        ))}
                      </span>
                    }
                  />
                )}
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Alerts</h2>
              <Card className="divide-y divide-line">{auth.enabled ? <Telegram /> : <Row title="Telegram" sub="Per-person alerts need sign-in." />}</Card>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">AI assistants</h2>
              <Card>{auth.enabled ? <AiAssistants /> : <Row title="AI assistants" sub="Keys need sign-in." />}</Card>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Live trading</h2>
              <Card>
                <Row
                  title={live.data?.ready ? "Ready" : "Not set up"}
                  sub={
                    live.data?.ready
                      ? `Hyperliquid${live.data.config.network === "testnet" ? " testnet" : ""}${live.data.config.maxAllocationUsd != null ? `, up to $${live.data.config.maxAllocationUsd.toLocaleString()} per run` : ""}.`
                      : "Connect your Hyperliquid account to trade with real money."
                  }
                >
                  <Btn href="/wallets" variant="ghost">
                    {live.data?.ready ? "Manage" : "Set up"}
                  </Btn>
                </Row>
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Appearance</h2>
              <Card>
                <Row title="Theme">
                  <Theme />
                </Row>
              </Card>
            </section>

            <p className="text-[13px] text-muted">
              Questions or problems? <Link href="/#faq" className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">Read the FAQ</Link>.
            </p>
          </>
        )}
      </div>
    </>
  );
}
