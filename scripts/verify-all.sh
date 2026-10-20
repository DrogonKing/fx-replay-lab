#!/usr/bin/env bash
# Full verification: tests, typecheck, build, offline proof. Run from the repo.
set -u
cd /root/fx-replay-lab
export NODE_OPTIONS="--max-old-space-size=1600"

echo '=== TESTS ==='
npx vitest run 2>&1 | tail -6

echo
echo '=== TYPECHECK (empty output = clean) ==='
npx tsc --noEmit -p tsconfig.json 2>&1 | head -5

echo
echo '=== BUILD ==='
npx vite build 2>&1 | tail -4
npx tsc -p tsconfig.main.json && node scripts/postbuild-main.mjs

echo
echo '=== OFFLINE VERIFICATION ==='
node scripts/verify-offline.mjs 2>&1 | tail -3

echo
echo '=== SOURCE FILES ==='
find src tests scripts -type f | sort

echo
echo '=== LINES OF CODE ==='
find src tests -name '*.ts' -o -name '*.tsx' | xargs wc -l | tail -1
