import type { CreateDeploymentInput, DeploymentRecord, Engine, EngineEvent, ExitsPatch } from "@weft/engine";
import type { Strategy } from "@weft/strategy";

/**
 * One Engine facade over a paper engine and an optional live engine. Each
 * engine owns its deployments (and its own store), so paper and live money
 * never share an executor. Routes keep talking to a single Engine.
 */
export class CompositeEngine implements Engine {
  private readonly paper: Engine;
  private readonly live: Engine | null;
  /** Live Solana token runs: always mainnet, so a store of their own (never tied to Hyperliquid's network). */
  private readonly solana: Engine | null;
  constructor(paper: Engine, live: Engine | null, solana: Engine | null = null) {
    this.paper = paper;
    this.live = live;
    this.solana = solana;
  }

  private all(): Engine[] {
    return [this.paper, this.live, this.solana].filter((e): e is Engine => e != null);
  }

  private async owner(id: string): Promise<Engine | null> {
    for (const e of this.all()) if (await e.getSnapshot(id)) return e;
    return null;
  }
  private async on<T>(id: string, fn: (e: Engine) => Promise<T>): Promise<T> {
    const e = await this.owner(id);
    if (!e) throw new Error(`unknown deployment ${id}`);
    return fn(e);
  }

  async createDeployment(input: CreateDeploymentInput): Promise<DeploymentRecord> {
    if (input.mode === "live") {
      if (input.strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "token")) {
        if (!this.solana) throw new Error("Solana trading is not configured on this server");
        return this.solana.createDeployment(input);
      }
      if (!this.live) throw new Error("live trading is not configured on this server");
      return this.live.createDeployment(input);
    }
    return this.paper.createDeployment(input);
  }
  async listDeployments() {
    return (await Promise.all(this.all().map((e) => e.listDeployments()))).flat();
  }
  async getSnapshot(id: string) {
    for (const e of this.all()) {
      const s = await e.getSnapshot(id);
      if (s) return s;
    }
    return null;
  }
  getEvents(id: string, opts?: { sinceTs?: number; limit?: number }) {
    return this.on(id, (e) => e.getEvents(id, opts));
  }
  getFills(id: string) {
    return this.on(id, (e) => e.getFills(id));
  }
  pause(id: string) {
    return this.on(id, (e) => e.pause(id));
  }
  resume(id: string) {
    return this.on(id, (e) => e.resume(id));
  }
  stop(id: string) {
    return this.on(id, (e) => e.stop(id));
  }
  kill(id: string) {
    return this.on(id, (e) => e.kill(id));
  }
  tick(id: string, now?: number) {
    return this.on(id, (e) => e.tick(id, now));
  }
  start() {
    for (const e of this.all()) e.start();
  }
  async shutdown() {
    await Promise.all(this.all().map((e) => e.shutdown()));
  }
  note(id: string, type: "warning" | "error" | "notify", message: string, data?: Record<string, unknown>) {
    return this.on(id, async (e) => {
      await e.note?.(id, type, message, data);
    });
  }
  closePosition(id: string, positionId: string, fraction: number) {
    return this.on(id, (e) => {
      if (!e.closePosition) throw new Error("this engine can’t sell positions on request");
      return e.closePosition(id, positionId, fraction);
    });
  }
  setExits(id: string, patch: ExitsPatch, positionIds?: string[]) {
    return this.on(id, (e) => {
      if (!e.setExits) throw new Error("this engine can’t change exits");
      return e.setExits(id, patch, positionIds);
    });
  }
  updateStrategy(id: string, strategy: Strategy) {
    return this.on(id, (e) => {
      if (!e.updateStrategy) throw new Error("this engine can’t change rules");
      return e.updateStrategy(id, strategy);
    });
  }
  subscribe(listener: (e: EngineEvent) => void) {
    const offs = this.all().map((e) => e.subscribe(listener));
    return () => {
      for (const off of offs) off();
    };
  }
}
