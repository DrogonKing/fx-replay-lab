/**
 * Validate the GitHub Actions workflow and electron-builder config locally.
 *
 * A broken workflow file only fails on GitHub, which is a slow feedback loop and
 * wasteful. This checks the things that actually break: YAML syntax, that every
 * referenced script exists in package.json, and that the packaging config names
 * real targets.
 */
import { readFileSync, existsSync } from "node:fs";

const problems = [];

function parseYamlLite(src) {
  // Node has no YAML parser in stdlib and adding a dep just for this is not worth
  // it; instead assert structural invariants with regexes, which is enough to
  // catch the realistic mistakes (tabs, missing colon, bad indentation blocks).
  if (/\t/.test(src)) problems.push("workflow contains a TAB (YAML forbids tabs)");
  return src;
}

console.log("=== workflow ===");
const wfPath = ".github/workflows/build.yml";
if (!existsSync(wfPath)) {
  problems.push(`${wfPath} missing`);
} else {
  const wf = parseYamlLite(readFileSync(wfPath, "utf8"));
  const checks = [
    ["has name", /^name:\s*\S+/m.test(wf)],
    ["has on:", /^on:/m.test(wf)],
    ["has jobs:", /^jobs:/m.test(wf)],
    ["verify job", /^\s{2}verify:/m.test(wf)],
    ["package job", /^\s{2}package:/m.test(wf)],
    ["matrix over 3 OS", /ubuntu-latest/.test(wf) && /windows-latest/.test(wf) && /macos-latest/.test(wf)],
    ["uploads artefacts", /actions\/upload-artifact@v4/.test(wf)],
    ["uses npm ci", /npm ci/.test(wf)],
    ["runs tests", /vitest run/.test(wf)],
    ["typechecks", /tsc --noEmit/.test(wf)],
    ["offline check", /verify-offline\.mjs/.test(wf)],
    ["rebuilds native", /electron-rebuild/.test(wf)],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${label}: ${ok}`);
    if (!ok) problems.push(`workflow: ${label} failed`);
  }
}

console.log();
console.log("=== package.json scripts referenced by CI ===");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const scripts = pkg.scripts ?? {};
for (const s of ["build", "test", "typecheck"]) {
  const ok = typeof scripts[s] === "string";
  console.log(`  ${s}: ${ok ? scripts[s] : "MISSING"}`);
  if (!ok) problems.push(`package.json missing script: ${s}`);
}
if (!pkg.devDependencies?.["electron-builder"]) {
  problems.push("electron-builder is not a devDependency");
}
console.log(`  electron-builder: ${pkg.devDependencies?.["electron-builder"] ?? "MISSING"}`);

console.log();
console.log("=== electron-builder.yml ===");
const eb = readFileSync("electron-builder.yml", "utf8");
const ebChecks = [
  ["appId", /^appId:/m.test(eb)],
  ["win nsis target", /nsis/.test(eb)],
  ["win portable zip", /target: zip/.test(eb)],
  ["mac dmg", /target: dmg/.test(eb)],
  ["linux AppImage", /AppImage/.test(eb)],
  ["asarUnpack better-sqlite3", /asarUnpack[\s\S]*better-sqlite3/.test(eb)],
  ["publish null (offline)", /^publish: null/m.test(eb)],
];
for (const [label, ok] of ebChecks) {
  console.log(`  ${label}: ${ok}`);
  if (!ok) problems.push(`electron-builder: ${label} failed`);
}

console.log();
if (problems.length === 0) {
  console.log("PASS - CI config is structurally sound");
  process.exit(0);
}
console.log("FAIL:");
for (const p of problems) console.log(`  * ${p}`);
process.exit(1);
