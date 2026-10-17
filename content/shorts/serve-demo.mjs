// Serves a static web build with clean URLs (/portfolio → portfolio.html), for recording.
//   node content/shorts/serve-demo.mjs <dir> [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
const dir = process.argv[2], port = Number(process.argv[3] ?? 3100);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".txt": "text/plain", ".webp": "image/webp" };
const exists = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  for (const p of [join(dir, path), join(dir, `${path}.html`), join(dir, path, "index.html")]) {
    if (await exists(p)) { res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" }); return res.end(await readFile(p)); }
  }
  res.writeHead(404); res.end(await readFile(join(dir, "404.html")).catch(() => "not found"));
}).listen(port, () => console.log(`serving ${dir} on http://localhost:${port}`));
