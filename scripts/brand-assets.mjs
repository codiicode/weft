// Generates every logo file from one definition of the mark (keep in step with
// apps/web/src/components/ui/Logo.tsx): favicon, app icons, and the $WEFT token icon.
// Usage: node scripts/brand-assets.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const sharp = require("sharp");

const INK = "#121214";
const PAPER = "#F4F3EF";
const PUB = new URL("../apps/web/public/", import.meta.url);

/** The mark in a 48×48 box. `tiny` keeps all three threads but draws them heavier for browser tabs. */
function mark({ tiny = false, w = tiny ? 4.4 : 3.6, r = tiny ? 5.6 : 5.2, ink = INK, paper = PAPER } = {}) {
  return `<g fill="none" stroke="${paper}" stroke-width="${w}" stroke-linecap="round">
    <path d="M8 13C20 13 21 24 30 24"/>
    <path d="M8 24H30"/>
    <path d="M8 35C20 35 21 24 30 24"/>
    <path d="M30 24H40"/>
  </g>
  <circle cx="30" cy="24" r="${r}" fill="${paper}"/>`;
}

/** Rounded-square app icon. */
const square = (opts = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${INK}"/>${mark(opts)}</svg>`;

/** Token icon: wallets crop to a circle, so the mark sits centred inside a full circle. */
const token = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="${INK}"/><g transform="translate(24 24) scale(0.78) translate(-24 -24)">${mark({ w: 3.8, r: 5.4 })}</g></svg>`;

const png = (svg, size, file) => sharp(Buffer.from(svg), { density: Math.max(72, (size / 48) * 72) }).resize(size, size).png().toFile(new URL(file, PUB).pathname);

writeFileSync(new URL("icon.svg", PUB), square({ tiny: true }));
writeFileSync(new URL("logo.svg", PUB), square({ w: 3.6, r: 5.2 }));
mkdirSync(new URL("token/", PUB), { recursive: true });
writeFileSync(new URL("token/weft-token.svg", PUB), token());

await Promise.all([
  png(square({ w: 4.4, r: 5.6 }), 180, "apple-touch-icon.png"),
  png(square({ w: 4, r: 5.4 }), 192, "icon-192.png"),
  png(square({ w: 3.6, r: 5.2 }), 512, "icon-512.png"),
  png(token(), 1000, "token/weft-token.png"),
  png(token(), 512, "token/weft-token-512.png"),
]);
console.log("brand assets written to apps/web/public");
