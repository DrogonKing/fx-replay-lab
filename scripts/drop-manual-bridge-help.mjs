/**
 * Remove the manual-install instructions from i18n.
 *
 * They told the user to install Python and run the bridge themselves. That is no longer true: the
 * app spawns a bundled interpreter, so the instructions are not just stale, they describe work the
 * user no longer has to do. Stale help text is worse than no help text.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = "src/core/i18n.ts";
let src = readFileSync(path, "utf8");
const before = src.length;

const dropped = [];
for (const key of ["br.howtoTitle", "br.howto1", "br.howto2", "br.howto3", "br.howtoNote"]) {
  // each key appears twice: once per locale
  const re = new RegExp(`^\\s*"${key.replace(/\./g, "\\.")}":\\s*"(?:[^"\\\\]|\\\\.)*",\\r?\\n`, "gm");
  const hits = src.match(re);
  if (hits) {
    dropped.push(`${key} x${hits.length}`);
    src = src.replace(re, "");
  }
}
writeFileSync(path, src);
console.log(`removed: ${dropped.join(", ") || "(nothing)"}`);
console.log(`size ${before} -> ${src.length}`);
