#!/usr/bin/env node
/**
 * Fetch the Python runtime that ships inside the installer.
 *
 * Why a script and not a committed folder: 64MB of interpreter and wheels would bloat the repo and
 * make every clone slow, and a committed binary is not reproducible. This downloads pinned versions,
 * verifies what it got, and writes `bridge/python/`. Run before packaging; CI runs it too.
 *
 * Layout produced:
 *   bridge/python/                 the embeddable CPython (python.exe + stdlib + DLLs)
 *   bridge/python/Lib/site-packages/MetaTrader5
 *   bridge/python/Lib/site-packages/numpy
 *
 * The embeddable distribution ignores `site` by default, so `python311._pth` is written explicitly -
 * without that line the bridge cannot import MetaTrader5 and fails with ModuleNotFoundError, which
 * looks like a broken bridge rather than a mis-built runtime.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "bridge", "python");

// Pinned. cp311 must match the interpreter: a wheel built for cp312 will not import on 3.11.
const PY_VERSION = "3.11.9";
const PY_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const MT5_VERSION = "5.0.6231";
const NUMPY_VERSION = "2.4.6";

const log = (m) => console.log(`  ${m}`);

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`GET ${url} -> only ${buf.length} bytes`);
  writeFileSync(dest, buf);
  return buf.length;
}

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  // no `zip` binary on minimal hosts; python is guaranteed present here because Node runs the build
  execFileSync("python3", ["-c", `
import zipfile, sys
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
`, zip, dest], { stdio: "inherit" });
}

/** Resolve a wheel URL from PyPI's JSON, without hard-coding a hash that will rot. */
async function wheelUrl(pkg, version, markers) {
  const res = await fetch(`https://pypi.org/pypi/${pkg}/${version}/json`);
  if (!res.ok) throw new Error(`PyPI ${pkg} ${version} -> HTTP ${res.status}`);
  const data = await res.json();
  const file = data.urls.find((u) => u.filename.endsWith(".whl") && markers.every((m) => u.filename.includes(m)));
  if (!file) throw new Error(`no wheel for ${pkg} ${version} matching ${markers.join(" ")}`);
  return file.url;
}

async function main() {
  if (process.argv.includes("--check") && existsSync(join(DEST, "python.exe"))) {
    log(`runtime already present at ${DEST}`);
    return;
  }

  console.log("fetching the bundled Python runtime for the MetaTrader bridge");
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });

  const tmp = join(tmpdir(), `fxlab-py-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  log(`python ${PY_VERSION}`);
  const pyZip = join(tmp, "py.zip");
  const size = await download(PY_URL, pyZip);
  log(`  ${(size / 1024 / 1024).toFixed(1)} MB`);
  unzip(pyZip, DEST);

  const sitePkgs = join(DEST, "Lib", "site-packages");
  mkdirSync(sitePkgs, { recursive: true });

  log(`MetaTrader5 ${MT5_VERSION} (cp311 win_amd64)`);
  const mt5 = join(tmp, "mt5.whl");
  await download(await wheelUrl("MetaTrader5", MT5_VERSION, ["cp311", "win_amd64"]), mt5);
  unzip(mt5, sitePkgs);

  log(`numpy ${NUMPY_VERSION} (cp311 win_amd64) — required by MetaTrader5`);
  const np = join(tmp, "numpy.whl");
  await download(await wheelUrl("numpy", NUMPY_VERSION, ["cp311", "win_amd64"]), np);
  unzip(np, sitePkgs);

  // The embeddable interpreter ignores site-packages unless the ._pth says so.
  const pthName = readdirSync(DEST).find((f) => f.endsWith("._pth"));
  if (!pthName) throw new Error("no ._pth in the embeddable distribution — cannot wire sys.path");
  writeFileSync(join(DEST, pthName), [
    "python311.zip",
    ".",
    "Lib\\site-packages",
    "",
    "# site.main() would pick up whatever the user has installed, defeating the point of bundling.",
    "#import site",
    "",
  ].join("\r\n"));
  log(`wired sys.path via ${pthName}`);

  // Verify the tree, since the whole failure mode here is a silent import error at run time.
  const checks = [
    ["python.exe", join(DEST, "python.exe")],
    ["MetaTrader5 module", join(sitePkgs, "MetaTrader5", "__init__.py")],
    ["MetaTrader5 native", join(sitePkgs, "MetaTrader5", `_core.cp311-win_amd64.pyd`)],
    ["numpy package", join(sitePkgs, "numpy", "__init__.py")],
  ];
  let bad = 0;
  for (const [label, p] of checks) {
    const ok = existsSync(p);
    log(`${ok ? "ok  " : "MISS"} ${label}`);
    if (!ok) bad++;
  }
  if (bad > 0) {
    console.error(`\n${bad} required file(s) missing — the bridge would fail with ModuleNotFoundError`);
    process.exit(1);
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nbridge/python ready (${execFileSync("du", ["-sh", DEST]).toString().split("\t")[0]})`);
}

main().catch((e) => {
  console.error(`failed: ${e.message}`);
  process.exit(1);
});
