#!/usr/bin/env python3
"""
Build the source archive with Python's zipfile (this host has no `zip` binary).

Excludes node_modules, dist, release artefacts, .git history and local history data. The archive is
checked AFTER building — listing it back and asserting the excluded paths are absent — because an
exclude pattern that silently does nothing is the usual way a "small" zip turns into 600MB.
"""
import os
import zipfile
from pathlib import Path

ROOT = Path("/root/fx-replay-lab")
OUT_DIR = Path("/tmp/fxlab-src")
OUT_DIR.mkdir(parents=True, exist_ok=True)

EXCLUDE_DIRS = {
    "node_modules", "dist", "release", ".git", "history",
    ".vite", "coverage", "out", ".cache", "__pycache__",
}
EXCLUDE_SUFFIX = {".log", ".bi5", ".zip", ".AppImage", ".exe", ".dmg", ".deb"}
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", ".env"}


def wanted(p: Path) -> bool:
    rel = p.relative_to(ROOT)
    if any(part in EXCLUDE_DIRS for part in rel.parts):
        return False
    if p.name in EXCLUDE_NAMES:
        return False
    if p.suffix in EXCLUDE_SUFFIX:
        return False
    return True


def build(zip_path: Path, roots: list[str], label: str) -> None:
    added = 0
    total = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for r in roots:
            base = ROOT / r
            if base.is_file():
                z.write(base, f"fx-replay-lab/{r}")
                added += 1
                total += base.stat().st_size
                continue
            if not base.exists():
                continue
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                for fn in filenames:
                    p = Path(dirpath) / fn
                    if not wanted(p):
                        continue
                    z.write(p, f"fx-replay-lab/{p.relative_to(ROOT)}")
                    added += 1
                    total += p.stat().st_size
    size = zip_path.stat().st_size
    print(f"{label}: {added} files, {total/1024/1024:.1f} MB raw -> {size/1024/1024:.1f} MB zipped")

    # verify what actually landed in the archive, rather than trusting the walk
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
    leaked = [n for n in names if any(f"/{d}/" in n for d in ("node_modules", "dist", "release", ".git"))]
    print(f"  verification: {len(names)} entries, excluded-path leaks: {len(leaked)}")
    if leaked:
        print("  LEAK:", leaked[:5])
    print(f"  renderer files inside: {sum(1 for n in names if '/src/renderer/' in n)}")
    return zip_path


print("=== full source archive ===")
build(
    OUT_DIR / "fx-replay-lab-src.zip",
    ["src", "docs", "scripts", "tests", "bridge", ".github",
     "package.json", "package-lock.json", "tsconfig.json", "tsconfig.main.json",
     "electron-builder.yml", "vite.config.ts", "vitest.config.ts",
     "eslint.config.js", ".eslintrc.cjs", ".prettierrc", ".prettierignore",
     ".gitignore", "PLAN.md", "DECISIONS.md", "README.md", "index.html"],
    "full",
)

print()
print("=== renderer + core only (the part you said matters most) ===")
build(
    OUT_DIR / "fx-replay-renderer.zip",
    ["src/renderer", "src/core", "src/main", "src/preload.ts",
     "package.json", "tsconfig.json", "vite.config.ts", "index.html"],
    "renderer",
)

print()
for f in sorted(OUT_DIR.glob("*.zip")):
    print(f"{f}  {f.stat().st_size/1024/1024:.1f} MB")
