#!/usr/bin/env bash
# Build a source zip: no node_modules, no dist, no release artefacts, no .git history.
set -uo pipefail
cd /root/fx-replay-lab

OUT=/tmp/fxlab-src
rm -rf "$OUT"; mkdir -p "$OUT"

echo "=== sizes before packaging ==="
du -sh node_modules dist .git 2>/dev/null
echo "repo total: $(du -sh . | cut -f1)"

echo
echo "=== what will be included (top level) ==="
for d in src docs scripts tests bridge .github; do
  [ -e "$d" ] && echo "  $d: $(du -sh "$d" | cut -f1)  ($(find "$d" -type f | wc -l) files)"
done
for f in package.json package-lock.json tsconfig.json tsconfig.main.json electron-builder.yml \
         vite.config.ts vitest.config.ts .eslintrc.cjs .prettierrc PLAN.md DECISIONS.md README.md; do
  [ -e "$f" ] && echo "  $f: $(du -h "$f" | cut -f1)"
done

echo
echo "=== checking for anything that looks like a secret before shipping ==="
# A source archive leaves the machine, so this is the moment to look.
grep -rIl --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  -iE 'ghp_[A-Za-z0-9]{20,}|api[_-]?key["'\'']?\s*[:=]\s*["'\''][A-Za-z0-9]{16,}|BEGIN (RSA|OPENSSH) PRIVATE KEY|password\s*[:=]\s*["'\''][^"'\'']{6,}' \
  . 2>/dev/null | head -20
echo "(nothing above = no obvious credential in tracked source)"

echo
echo "=== building zip (excluding node_modules, dist, release, .git) ==="
cd /root
zip -rq "$OUT/fx-replay-lab-src.zip" fx-replay-lab \
  -x 'fx-replay-lab/node_modules/*' \
  -x 'fx-replay-lab/dist/*' \
  -x 'fx-replay-lab/release/*' \
  -x 'fx-replay-lab/.git/*' \
  -x 'fx-replay-lab/history/*' \
  -x 'fx-replay-lab/*.log' \
  -x '*/node_modules/*' \
  -x '*/dist/*' \
  -x '*/.git/*'
ls -la "$OUT/fx-replay-lab-src.zip"
echo "contents count: $(unzip -l "$OUT/fx-replay-lab-src.zip" | tail -1)"

echo
echo "=== renderer-only zip, in case the full one is awkward ==="
cd /root/fx-replay-lab
zip -rq "$OUT/fx-replay-renderer.zip" src/renderer src/core src/main src/preload.ts \
  src/renderer/index.html package.json tsconfig.json vite.config.ts 2>/dev/null
ls -la "$OUT/fx-replay-renderer.zip"
echo "  renderer files: $(find src/renderer -type f | wc -l)"
du -sh src/renderer
