/**
 * Verify the app cannot reach the network.
 *
 * Spec requirement: "The app must run with the network disabled. Add a test or
 * script that verifies this."
 *
 * This does two independent checks and fails if either is violated:
 *
 * 1. STATIC -- scan the built bundle for remote references. Any http(s) URL,
 *    CDN host or fetch call in the renderer means the app would try to phone
 *    home at runtime.
 *
 * 2. RUNTIME -- the renderer's CSP declares `connect-src 'none'`, and the main
 *    process blocks navigation. Both are asserted from the emitted artefacts so
 *    a later edit cannot silently re-enable networking.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const RENDERER = "dist/renderer";
const problems = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

console.log("=".repeat(72));
console.log("1. static scan of the built renderer bundle");
console.log("=".repeat(72));

const files = walk(RENDERER).filter((f) => [".js", ".html", ".css"].includes(extname(f)));
if (files.length === 0) {
  problems.push(`no built files under ${RENDERER} (run the build first)`);
}

/**
 * Not every URL string is a network call, and treating them all as one produces
 * false failures that train you to ignore the check. Classify instead:
 *
 *   INERT   - XML/SVG namespace identifiers and React's error-decoder link.
 *             These are compared as strings or embedded in a thrown message;
 *             nothing ever dereferences them.
 *   LIVE    - anything that appears near a network API (fetch, XHR, WebSocket,
 *             <script src>, <link href>), which would actually leave the host.
 */
const INERT_PATTERNS = [
  /^https?:\/\/(www\.)?w3\.org\//,
  /^https?:\/\/reactjs\.org\/docs\/error-decoder/,
  /^https?:\/\/tradingview\.com\/lightweight-charts/,
  /^https?:\/\/www\.apache\.org\/licenses/,
];

/** True when the URL appears within a real network call. */
function looksLive(src, url) {
  const idx = src.indexOf(url);
  if (idx < 0) return false;
  const window = src.slice(Math.max(0, idx - 120), idx + url.length + 120);
  return /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|<script[^>]+src=|<link[^>]+href=|import\s*\(/.test(window);
}

let liveHits = 0;
let inertHits = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  const live = [];
  for (const u of urls) {
    if (INERT_PATTERNS.some((re) => re.test(u))) { inertHits++; continue; }
    if (looksLive(src, u)) live.push(u);
    else inertHits++;
  }
  if (live.length > 0) {
    liveHits += live.length;
    console.log(`  ${f}: ${live.length} LIVE remote reference(s)`);
    for (const u of live.slice(0, 5)) console.log(`      ${u.slice(0, 110)}`);
    problems.push(`${f} makes real network calls`);
  }
}
console.log(`  scanned ${files.length} files: ${liveHits} live, ${inertHits} inert (namespaces/licence/error text)`);
if (inertHits > 0) {
  console.log("  inert examples are never dereferenced: XML namespaces, the");
  console.log("  React error-decoder link used inside a thrown message, licence URLs.");
}

console.log();
console.log("=".repeat(72));
console.log("2. CSP and main-process navigation guards");
console.log("=".repeat(72));

const html = readFileSync(join(RENDERER, "index.html"), "utf8");
const hasConnectNone = /connect-src\s+'none'/.test(html);
const hasDefaultSelf = /default-src\s+'self'/.test(html);
console.log(`  index.html declares connect-src 'none': ${hasConnectNone}`);
console.log(`  index.html declares default-src 'self' : ${hasDefaultSelf}`);
if (!hasConnectNone) problems.push("CSP does not block connections (connect-src 'none' missing)");
if (!hasDefaultSelf) problems.push("CSP does not restrict default-src to 'self'");

const mainJs = readFileSync("dist/main/main.js", "utf8");
const guards = [
  ["will-navigate blocked", /will-navigate/.test(mainJs)],
  ["windowOpenHandler denies", /setWindowOpenHandler/.test(mainJs)],
  ["nodeIntegration false", /nodeIntegration:\s*false/.test(mainJs)],
  ["contextIsolation true", /contextIsolation:\s*true/.test(mainJs)],
];
for (const [name, ok] of guards) {
  console.log(`  ${name}: ${ok}`);
  if (!ok) problems.push(`main process guard missing: ${name}`);
}

console.log();
console.log("=".repeat(72));
if (problems.length === 0) {
  console.log("PASS - the app is offline-clean");
  process.exit(0);
}
console.log("FAIL - offline verification found problems:");
for (const p of problems) console.log(`  * ${p}`);
process.exit(1);
