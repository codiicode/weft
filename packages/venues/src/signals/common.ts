import type { Signal, SignalKind, SignalSnapshot } from "@weft/strategy";
import type { SignalProvider } from "../types.ts";

export type SignalOf<K extends SignalKind> = Extract<Signal, { kind: K }>;
export type Fields = SignalSnapshot["fields"];

/**
 * Wrap a fetcher as a SignalProvider that never throws: any error → null
 * (the evaluator treats the signal as unknown). Pass `onError` to log.
 */
export function defineProvider<K extends SignalKind>(
  kinds: readonly K[],
  mode: "live" | "simulated",
  fetcher: (signal: SignalOf<K>, now: number) => Promise<Fields | null>,
  onError?: (kind: SignalKind, err: unknown) => void
): SignalProvider {
  return {
    kinds,
    mode,
    async fetch(signal: Signal, now: number): Promise<SignalSnapshot | null> {
      if (!(kinds as readonly SignalKind[]).includes(signal.kind)) return null;
      try {
        const fields = await fetcher(signal as SignalOf<K>, now);
        return fields ? { asOf: now, fields } : null;
      } catch (err) {
        onError?.(signal.kind, err);
        return null;
      }
    },
  };
}
