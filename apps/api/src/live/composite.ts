import type { CreateDeploymentInput, DeploymentRecord, Engine, EngineEvent } from "@weft/engine";

/**
 * One Engine facade over a paper engine and an optional live engine. Each
 * engine owns its deployments (and its own store), so paper and live money
 * never share an executor. Routes keep talking to a single Engine.
 */
export class CompositeEngine implements Engine {
  private readonly paper: Engine;
  private readonly live: Engine | null;
  constructor(paper: Engine, live: Engine | null) {
    this.paper = paper;
    this.live = live;
  }

  private async owner(id: string): Promise<Engine | null> {
    if (await this.paper.getSnapshot(id)) return this.paper;
    if (this.live && (await this.live.getSnapshot(id))) return this.live;
    return null;
  }
  private async on<T>(id: string, fn: (e: Engine) => Promise<T>): Promise<T> {
    const e = await this.owner(id);
    if (!e) throw new Error(`unknown deployment ${id}`);
    return fn(e);
  }

  async createDeployment(input: CreateDeploymentInput): Promise<DeploymentRecord> {
    if (input.mode === "live") {
      if (!this.live) throw new Error("live trading is not configured on this server");
      return this.live.createDeployment(input);
    }
    return this.paper.createDeployment(input);
  }
  async listDeployments() {
    return [...(await this.paper.listDeployments()), ...(this.live ? await this.live.listDeployments() : [])];
  }
  async getSnapshot(id: string) {
    return (await this.paper.getSnapshot(id)) ?? (this.live ? await this.live.getSnapshot(id) : null);
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
    this.paper.start();
    this.live?.start();
  }
  async shutdown() {
    await Promise.all([this.paper.shutdown(), this.live?.shutdown()]);
  }
  subscribe(listener: (e: EngineEvent) => void) {
    const a = this.paper.subscribe(listener);
    const b = this.live?.subscribe(listener);
    return () => {
      a();
      b?.();
    };
  }
}
