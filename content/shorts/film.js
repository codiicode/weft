/* Shared pieces for the short films: timing, easing, the camera, masked type, the finish
 * (grid, glow, grain, vignette) and the weft knot end card. Same look as the launch video.
 * A film page includes this, builds its scenes, and defines window.renderAt(t) / window.DURATION. */

const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - x, 3);
const eo5 = (x) => 1 - Math.pow(1 - x, 5);
const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const eox = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const eix = (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10));
const eiox = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2);
const back = (x) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
const lerp = (a, b, x) => a + (b - a) * x;
const vel = (f, t, h = 1 / 240) => (f(t + h) - f(t - h)) / (2 * h);
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const div = (html, style = "", parent) => { const d = document.createElement("div"); d.innerHTML = html; d.style.cssText = style; if (parent) parent.appendChild(d); return d; };
const svgText = (parent, x, y, str, attrs = {}) => { const e = el("text", { x, y, ...attrs }, parent); e.textContent = str; return e; };
const C = { ink: "#f4f3ef", ink2: "#cfcec9", muted: "#a3a29d", faint: "#6f6e6a", line: "#26262a", line2: "#34343a", card: "#141416", paper: "#0c0c0d",
  blue: "#7c8cff", violet: "#a78bfa", amber: "#f5a524", pink: "#f472b6", sky: "#38bdf8", long: "#3ecf8e", short: "#ff6b6b" };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, x) => { const A = rgb(a), B = rgb(b); return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], x))).join(",")})`; };
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1; };
const srnd = (s) => () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);

/* the camera: per-element directional motion blur via an SVG filter */
const MB = {};
function mbFilter(id) {
  if (!MB[id]) { const f = el("filter", { id: `mb-${id}`, x: "-5%", y: "-5%", width: "110%", height: "110%" }, $("defs")); MB[id] = el("feGaussianBlur", { stdDeviation: "0 0" }, f); }
  return MB[id];
}
const filterOf = (id, bx, by, blur) => {
  const f = [];
  if (bx > 0.4 || by > 0.4) { mbFilter(id).setAttribute("stdDeviation", `${bx.toFixed(1)} ${by.toFixed(1)}`); f.push(`url(#mb-${id})`); }
  if (blur > 0.4) f.push(`blur(${blur.toFixed(1)}px)`);
  return f.length ? f.join(" ") : "none";
};
function put(id, { o = 1, x = 0, y = 0, s = 1, ox = 960, oy = 540, blur = 0, bx = 0, by = 0, clip = "", extra = "" } = {}) {
  const e = $(id);
  if (o <= 0.002) { e.style.opacity = 0; e.style.visibility = "hidden"; return false; }
  e.style.opacity = o; e.style.visibility = "visible";
  e.style.transformOrigin = `${ox}px ${oy}px`;
  e.style.transform = `${extra} translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(5)})`;
  e.style.filter = filterOf(id, bx, by, blur);
  e.style.clipPath = clip || "none";
  return true;
}

/* type behind masks */
function maskWords(target, text) { target.innerHTML = text.split(" ").map((w) => `<span class="m"><span>${w}</span></span>`).join(" "); return [...target.querySelectorAll(".m > span")]; }
function maskChars(target, text) { target.innerHTML = [...text].map((w) => `<span class="m"><span>${w}</span></span>`).join(""); return [...target.querySelectorAll(".m > span")]; }
function reveal(ws, t, t0, st = 0.05, d = 0.8, out = null) {
  ws.forEach((w, i) => {
    let y = (1 - eox(seg(t, t0 + i * st, t0 + i * st + d))) * 140;
    if (out != null) y -= eix(seg(t, out + i * st * 0.6, out + i * st * 0.6 + 0.45)) * 140;
    w.style.transform = `translateY(${y.toFixed(2)}%)`;
  });
}
/** Captions that roll over each other at the top of the frame: [[t, text], …]. */
function captions(target, list, end = Infinity) {
  const rows = list.map(([t, text]) => { const d = div("", "position:absolute;left:0;right:0;text-align:center", target); return { t, ws: maskWords(d, text) }; });
  return (t) => rows.forEach((r, i) => reveal(r.ws, t, r.t, 0.04, 0.8, i < rows.length - 1 ? rows[i + 1].t - 0.35 : end));
}

/* finish: grid, glow, grain, vignette */
const STAGE_FINISH = `
  <svg width="0" height="0" style="position:absolute"><defs id="defs">
    <filter id="glow" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="bloom" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs></svg>
  <svg id="warp" width="1920" height="1080" style="position:absolute;inset:0"></svg>
  <div id="glowBg" style="position:absolute;inset:0"></div>`;
const STAGE_TOP = `
  <div id="vig" style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 78% 78% at 50% 50%,transparent 58%,rgba(0,0,0,0.42) 100%)"></div>
  <div id="grain" style="position:absolute;inset:0;pointer-events:none;background-size:256px 256px"></div>`;
let GRAIN = [];
function setupFinish() {
  for (let x = 24; x < 1920; x += 48) el("line", { x1: x, y1: 0, x2: x, y2: 1080, stroke: "#fff", "stroke-opacity": 0.022 }, $("warp"));
  GRAIN = Array.from({ length: 8 }, (_, k) => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const x = c.getContext("2d"), im = x.createImageData(256, 256), r = srnd(101 + k * 7919);
    for (let i = 0; i < im.data.length; i += 4) { const v = r(); const w = v > 0.5; im.data[i] = im.data[i + 1] = im.data[i + 2] = w ? 255 : 0; im.data[i + 3] = Math.abs(v - 0.5) * 2 * (w ? 11 : 22); }
    x.putImageData(im, 0, 0); return `url(${c.toDataURL()})`;
  });
}
function finishFrame(t) {
  const gx = 50 + 20 * Math.sin(t * 0.21), gy = 40 + 15 * Math.cos(t * 0.17);
  $("glowBg").style.background = `radial-gradient(1100px 700px at ${gx}% ${gy}%, rgba(124,140,255,0.07), transparent 70%)`;
  const fk = Math.floor(t * 24);
  $("grain").style.backgroundImage = GRAIN[fk % 8];
  $("grain").style.backgroundPosition = `${(hash(fk, 1) * 128).toFixed(0)}px ${(hash(fk, 2) * 128).toFixed(0)}px`;
}

/* the end card: five threads tie into the knot, one leaves; weft.fi underneath */
function endCard(container, { line1 = "weft.fi", line2 = "Write your first strategy. It’s free to try." } = {}) {
  const K = { x: 960, y: 400 };
  const root = div(`<svg width="1920" height="1080" style="position:absolute;inset:0"><g class="th" fill="none" stroke-linecap="round"></g></svg>
    <div class="wm" style="position:absolute;left:0;right:0;top:530px;text-align:center;font-size:140px;font-weight:600;letter-spacing:-0.045em"></div>
    <div class="l1" style="position:absolute;left:0;right:0;top:730px;text-align:center;font-size:44px;font-weight:600;letter-spacing:-0.015em"></div>
    <div class="l2 serif muted" style="position:absolute;left:0;right:0;top:805px;text-align:center;font-size:44px"></div>`, "position:absolute;inset:0", container);
  const g = root.querySelector(".th");
  const cols = [C.amber, C.pink, C.sky, C.blue, C.violet, C.long];
  const paths = [
    `M -40 230 C 400 230 640 ${K.y} ${K.x} ${K.y}`, `M -40 315 C 420 315 660 ${K.y} ${K.x} ${K.y}`, `M -40 ${K.y} L ${K.x} ${K.y}`,
    `M -40 485 C 420 485 660 ${K.y} ${K.x} ${K.y}`, `M -40 570 C 400 570 640 ${K.y} ${K.x} ${K.y}`, `M ${K.x} ${K.y} L 1980 ${K.y}`,
  ].map((d, i) => el("path", { d, stroke: cols[i], "stroke-width": i === 5 ? 5 : 3.5 }, g));
  const lens = paths.map((p) => p.getTotalLength());
  const heads = cols.map((c, i) => el("circle", { r: i === 5 ? 6 : 4.5, fill: c, filter: "url(#glow)", opacity: 0 }, g));
  const ring = el("circle", { cx: K.x, cy: K.y, r: 0, fill: "none", stroke: C.long, "stroke-width": 2 }, g);
  const knot = el("circle", { cx: K.x, cy: K.y, r: 0, fill: C.ink, filter: "url(#bloom)" }, g);
  const wm = maskChars(root.querySelector(".wm"), "weft"), l1 = maskWords(root.querySelector(".l1"), line1), l2 = maskWords(root.querySelector(".l2"), line2);
  return (l) => {
    root.style.opacity = l < 0 ? 0 : 1;
    paths.forEach((p, i) => {
      const st = i < 5 ? 0.05 + i * 0.08 : 1.0, pr = eio(seg(l, st, st + (i < 5 ? 0.95 : 0.9)));
      p.style.strokeDasharray = lens[i]; p.style.strokeDashoffset = lens[i] * (1 - pr);
      if (pr > 0 && pr < 1) { const pt = p.getPointAtLength(lens[i] * pr); heads[i].setAttribute("cx", pt.x); heads[i].setAttribute("cy", pt.y); heads[i].setAttribute("opacity", 1); } else heads[i].setAttribute("opacity", 0);
    });
    const k = seg(l, 0.95, 1.35); knot.setAttribute("r", Math.max(0, 22 * back(k) * (k > 0 ? 1 : 0)));
    const r = seg(l, 1.05, 2.1); ring.setAttribute("r", 22 + 110 * eox(r)); ring.setAttribute("opacity", r > 0 ? (1 - r) * 0.8 : 0);
    reveal(wm, l, 1.3, 0.05, 0.9); reveal(l1, l, 1.9, 0.05, 0.9); reveal(l2, l, 2.15, 0.04, 0.9);
  };
}
