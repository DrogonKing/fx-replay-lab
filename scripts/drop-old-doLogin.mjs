/**
 * Remove the old doLogin handler.
 *
 * It was replaced by doConnect, which starts the bundled bridge before logging in. Leaving it would
 * be dead code that still looks like a live path — and dead code in a credential-handling file is
 * exactly the kind that gets accidentally re-wired later.
 *
 * Markers are the function's own comment header and its dependency array, both unique.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = "src/renderer/panels/BrokerPanel.tsx";
let src = readFileSync(path, "utf8");

const startMarker = `  /**
   * Log the terminal in through the bridge.`;
const endMarker = `  }, [bridgeUrl, mtLogin, mtPassword, mtServer, onStatus, t, testBridge]);
`;

const startAt = src.indexOf(startMarker);
if (startAt < 0) { console.log("start marker not found"); process.exit(1); }
const endAt = src.indexOf(endMarker, startAt);
if (endAt < 0) { console.log("end marker not found — refusing to guess"); process.exit(1); }

const removed = src.slice(startAt, endAt + endMarker.length);
src = src.slice(0, startAt) + src.slice(endAt + endMarker.length);
writeFileSync(path, src);
console.log(`removed ${removed.split("\n").length} lines (doLogin)`);
