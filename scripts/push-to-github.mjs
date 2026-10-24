/**
 * Push the working tree to GitHub WITHOUT a git binary.
 *
 * This dev box has no git installed (measured: no git on PATH, none in Program
 * Files, none inside GitHub Desktop), but CI needs the repo on GitHub to build
 * installers. So this walks the working tree exactly like `git add .` would
 * (honouring .gitignore), uploads it through the Git Data API (blobs for
 * binaries, inline content for text, chained tree batches), creates one
 * commit, and force-updates `main` — the local tree is the source of truth.
 *
 * Env: GH_TOKEN (required), GH_REPO (default fx-replay-lab), GH_MESSAGE.
 * The token is never read from a file and never written to one.
 */
import { promises as fs } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import process from "node:process";

const API = "https://api.github.com";
const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || "fx-replay-lab";
const MESSAGE = process.env.GH_MESSAGE || "v2: MT integration, TradingView UI, paper trading";

if (!TOKEN) {
  console.error("GH_TOKEN is required");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "fx-replay-lab-push",
};

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

// ---- .gitignore (small, honest subset: dirs, globs, negations) ----
const BINARY_EXT = new Set([".png", ".ico", ".icons", ".icns", ".gif", ".jpg", ".jpeg", ".woff", ".woff2"]);

async function loadIgnore(root) {
  const raw = await fs.readFile(join(root, ".gitignore"), "utf8").catch(() => "");
  const rules = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    rules.push(t.startsWith("!") ? { neg: true, pat: t.slice(1) } : { neg: false, pat: t });
  }
  return rules;
}

function ignored(relPath, isDir, rules) {
  const posix = relPath.split(sep).join("/");
  const segs = posix.split("/");
  const name = segs[segs.length - 1];
  let verdict = false;
  for (const { neg, pat } of rules) {
    if (pat.endsWith("/")) {
      // directory rule: matches the dir itself or anything under it. Multi-segment
      // paths ("bridge/python/") must match as a PATH PREFIX, not a single segment —
      // matching segments alone let the whole 64MB vendored runtime through once.
      const dir = pat.slice(0, -1);
      const hit = posix === dir || posix.startsWith(dir + "/") ||
        segs.slice(0, -1).includes(dir) || (isDir && name === dir);
      if (hit) verdict = !neg;
      continue;
    }
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      if (re.test(name) || re.test(posix)) verdict = !neg;
      continue;
    }
    // exact file or directory prefix
    const p = pat.split("/");
    if (name === pat || segs.slice(0, p.length).join("/") === pat) verdict = !neg;
  }
  return verdict;
}

async function walk(root) {
  const rules = await loadIgnore(root);
  const files = [];
  async function rec(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      if (ignored(rel, ent.isDirectory(), rules)) continue;
      if (ent.isDirectory()) {
        // never ship python bytecode caches regardless of ignore rules
        if (ent.name === "__pycache__") continue;
        await rec(full);
      } else {
        files.push({ rel: rel.split(sep).join("/"), full });
      }
    }
  }
  await rec(root);
  return files;
}

// ---- GitHub: repo + blobs + tree + commit + ref ----
async function main() {
  const me = await api("/user");
  console.log(`authenticated as ${me.login}`);

  let repo;
  try {
    repo = await api("/user/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: REPO, private: true, description: "Offline FX replay/backtest terminal with MetaTrader integration" }),
    });
    console.log(`created private repo ${repo.full_name}`);
  } catch (e) {
    if (String(e).includes("422")) {
      repo = await api(`/repos/${me.login}/${REPO}`);
      console.log(`reusing existing repo ${repo.full_name}`);
    } else throw e;
  }
  const slug = repo.full_name;

  let parent = null;
  let baseTree = null;
  try {
    const ref = await api(`/repos/${slug}/git/ref/heads/main`);
    parent = ref.object.sha;
    const commit = await api(`/repos/${slug}/git/commits/${parent}`);
    baseTree = commit.tree.sha;
    console.log(`existing main at ${parent.slice(0, 8)}`);
  } catch {
    console.log("no main branch yet - creating it");
  }

  const files = await walk(process.cwd());
  // large text files (package-lock can top 1MB) go the blob route like binaries,
  // so a single tree request never carries a giant inline content string
  const isInline = async (f) => {
    if (BINARY_EXT.has(extOf(f.rel))) return false;
    const st = await fs.stat(f.full);
    return st.size <= 512 * 1024;
  };
  const inline = [];
  const blobFiles = [];
  for (const f of files) (await isInline(f)) ? inline.push(f) : blobFiles.push(f);
  console.log(`${files.length} files (${inline.length} inline, ${blobFiles.length} as blobs)`);

  // blobs for binaries and big files
  const blobEntries = [];
  for (const f of blobFiles) {
    const buf = await fs.readFile(f.full);
    const blob = await api(`/repos/${slug}/git/blobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: buf.toString("base64"), encoding: "base64" }),
    });
    blobEntries.push({ path: f.rel, type: "blob", mode: "100644", sha: blob.sha });
    console.log(`  blob ${f.rel} (${buf.length}B)`);
  }

  // inline entries chained in BYTE-budgeted batches (100-file count batches once blew
  // the request limit when a batch happened to hold package-lock.json)
  const BATCH_BYTES = 3 * 1024 * 1024;
  const entries = [
    ...blobEntries,
    ...await Promise.all(inline.map(async (f) => ({
      path: f.rel, type: "blob", mode: "100644", content: await fs.readFile(f.full, "utf8"),
    }))),
  ];
  let treeSha = baseTree;
  for (let i = 0; i < entries.length; ) {
    const chunk = [];
    let bytes = 0;
    while (i < entries.length && chunk.length < 200 &&
           (bytes < BATCH_BYTES || chunk.length === 0)) {
      const e = entries[i];
      chunk.push(e);
      bytes += e.content ? e.content.length : 64;
      i++;
    }
    const t = await api(`/repos/${slug}/git/trees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(treeSha ? { base_tree: treeSha } : {}), tree: chunk }),
    });
    treeSha = t.sha;
    console.log(`  tree batch -> ${treeSha.slice(0, 8)} (${i}/${entries.length}, ${(bytes / 1048576).toFixed(1)}MB)`);
  }

  const commit = await api(`/repos/${slug}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: MESSAGE, tree: treeSha, parents: parent ? [parent] : [] }),
  });
  console.log(`commit ${commit.sha.slice(0, 8)}: ${MESSAGE}`);

  if (parent) {
    await api(`/repos/${slug}/git/refs/heads/main`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    await api(`/repos/${slug}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha }),
    });
  }
  console.log(`\npushed: ${repo.html_url}/tree/main`);
  console.log(`actions: ${repo.html_url}/actions`);
}

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
