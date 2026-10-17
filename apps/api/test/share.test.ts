import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../../../packages/engine/test/fakes.ts";
import { StrategyLibrary } from "../src/lib/library.ts";
import { createApp } from "../src/app.ts";

describe("share links", () => {
  const t = setup();
  const app = createApp({ catalog: { async list() { return []; } }, marketData: t.market, engine: t.engine, library: new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-share-")), "lib.db")), signalModes: {} });

  it("serves the strategy's own preview tags and sends people on to it", async () => {
    const r = await app.request("/share/saylor-buys");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<meta property="og:title" content="Saylor buys, you buy · Weft">');
    expect(html).toContain("https://weft.fi/og/strategy/saylor-buys.png");
    expect(html).toContain('location.replace("https://weft.fi/strategy?id=saylor-buys")');
    expect((await app.request("/share/nope")).status).toBe(302);
  });

  it("draws a 1200×630 PNG card", async () => {
    const r = await app.request("/og/strategy/buy-the-panic.png");
    expect(r.headers.get("content-type")).toBe("image/png");
    const png = new Uint8Array(await r.arrayBuffer());
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    const view = new DataView(png.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  }, 20_000);
});
