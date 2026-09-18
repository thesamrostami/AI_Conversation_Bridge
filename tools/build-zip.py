"""Package the extension for the Chrome Web Store.
Run: python tools/build-zip.py  ->  dist/conversation-bridge-<version>.zip
"""
import json
import os
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXCLUDE_DIRS = {"tools", "dist", "node_modules", ".git", ".claude"}
EXCLUDE_FILES = {"package.json", "package-lock.json", "README.md", ".gitignore", ".DS_Store", "Thumbs.db"}
EXCLUDE_EXT = {".md", ".py", ".mjs", ".zip", ".log"}

manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
version = manifest["version"]
out_dir = os.path.join(ROOT, "dist")
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, f"conversation-bridge-{version}.zip")

count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for name in filenames:
            if name in EXCLUDE_FILES or os.path.splitext(name)[1] in EXCLUDE_EXT:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            z.write(full, rel)
            count += 1
print(f"wrote {out} ({count} files, {os.path.getsize(out) // 1024} KB)")
