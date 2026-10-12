/** Deterministic, logo-free token mark: a conic gradient keyed off the ticker. */
function hue(sym: string) {
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function TokenAvatar({ sym, size = 40 }: { sym: string; size?: number }) {
  const h = hue(sym);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.25)]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `conic-gradient(from 210deg, oklch(0.72 0.17 ${h}), oklch(0.55 0.19 ${(h + 60) % 360}), oklch(0.72 0.17 ${h}))`,
      }}
      aria-hidden
    >
      {sym.replace("$", "").slice(0, 1)}
    </span>
  );
}
