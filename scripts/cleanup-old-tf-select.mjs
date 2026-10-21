import { readFileSync, writeFileSync } from "node:fs";

/**
 * Remove the leftovers of the old toolbar timeframe <select>.
 *
 * The new TimeframeMenu replaced the control, and a patch left the old option list stranded inside
 * a hidden placeholder. Deleting a known line range is safe here because the block is identified by
 * its own unique markers rather than by numbers that could drift.
 */
const path = "src/renderer/App.tsx";
let src = readFileSync(path, "utf8");

const startMarker = `        {/* keep the old select out of the DOM entirely: one control for one question */}
        <select data-field="toolbar-tf-hidden" value={tf.label} onChange={() => {}} hidden>`;
const endMarker = `          </select>
        </label>
`;

const startAt = src.indexOf(startMarker);
if (startAt < 0) {
  console.log("start marker not found — nothing to do");
  process.exit(0);
}
const endAt = src.indexOf(endMarker, startAt);
if (endAt < 0) {
  console.log("end marker not found — refusing to guess");
  process.exit(1);
}
const removed = src.slice(startAt, endAt + endMarker.length);
src = src.slice(0, startAt) + src.slice(endAt + endMarker.length);
writeFileSync(path, src);
console.log(`removed ${removed.split("\n").length} lines of the old select`);
