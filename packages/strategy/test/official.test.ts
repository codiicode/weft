import { describe, expect, it } from "vitest";
import { OFFICIAL_TOKENS, officialMint, pinOfficialTokens } from "../src/official.ts";

const WEFT = OFFICIAL_TOKENS.WEFT!;
const tok = (mint: string, symbol = "WEFT") => ({ kind: "token", chain: "solana", mint, symbol, quote: "SOL" });

describe("Weft's own token", () => {
  it("knows the ticker however it's written", () => {
    expect(officialMint("$weft")).toBe(WEFT);
    expect(officialMint(" WEFT ")).toBe(WEFT);
    expect(officialMint("WIF")).toBeNull();
  });
  it("points every WEFT in a strategy at the official mint, and leaves other tokens alone", () => {
    const s = {
      signals: [{ id: "p", kind: "price", params: { instrument: tok("FakeWeftMint111") } }],
      actions: [{ type: "open", instrument: tok("FakeWeftMint111", "$weft") }, { type: "open", instrument: tok("WifMint111", "WIF") }],
    } as never;
    const { strategy, changed } = pinOfficialTokens(s);
    const j = strategy as unknown as { signals: { params: { instrument: { mint: string } } }[]; actions: { instrument: { mint: string } }[] };
    expect(j.signals[0]!.params.instrument.mint).toBe(WEFT);
    expect(j.actions[0]!.instrument.mint).toBe(WEFT);
    expect(j.actions[1]!.instrument.mint).toBe("WifMint111");
    expect(changed).toHaveLength(2);
    expect(pinOfficialTokens(strategy).changed).toEqual([]);
  });
});
