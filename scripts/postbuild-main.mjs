/**
 * Write a CommonJS marker into the compiled output.
 *
 * The repo root declares "type": "module" (needed by Vite and the ESM toolchain),
 * but tsc emits the Electron main process AND the shared core as CommonJS. Without
 * a marker, Node resolves those .js files as ESM and every `exports`/`require`
 * reference throws "exports is not defined in ES module scope".
 *
 * The marker goes at the ROOT of dist/ because the main process now imports
 * dist/core alongside dist/main, and both need the same resolution. Putting it only
 * in dist/main silently broke the core imports.
 *
 * The renderer is unaffected: its bundle is loaded by Chromium via a <script
 * type="module"> tag, where a package.json "type" field means nothing.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const target = resolve(process.cwd(), "dist/package.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
console.log("wrote", target);
