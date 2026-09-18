"""Render the website hero and Chrome Web Store screenshots from the real side panel.

Run: python tools/make-marketing.py  ->  dist/marketing/*.png + *.jpg

Uses tools/marketing/hero.html (the frame) + tools/fixtures/panel-dev.html?seed=demo (the panel)
rendered by headless Chrome. Needs Chrome and Pillow. Set CHROME=<path> if Chrome is not found.
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "dist", "marketing")
PORT = 8765

HERO_SUB = "Save, export, organise and hand off AI chats — free, 100% local, no account."

# name, size, hero.html query params
SLIDES = [
    ("website-hero", (1920, 1080), {"view": "capture", "title": "AI Conversation|*Bridge*", "sub": HERO_SUB, "scale": "1.15"}),
    ("store-1-capture", (1280, 800), {"view": "capture", "title": "Capture any chat as|clean *Markdown*", "sub": "Code blocks, tables and links preserved. Copy, download or save in one click.", "scale": "0.92"}),
    ("store-2-library", (1280, 800), {"view": "library", "title": "A searchable|*local library*", "sub": "Unlimited saved chats with tags, notes, favourites and full-text search.", "scale": "0.92", "pills": "0"}),
    ("store-3-reader", (1280, 800), {"view": "library", "open": "https://chatgpt.com/c/demo-123", "collapse": "1", "title": "Read, edit and|*export* anywhere", "sub": "Markdown, HTML, JSON or PDF — with Obsidian-ready frontmatter.", "scale": "0.92", "pills": "0"}),
    ("store-4-workflows", (1280, 800), {"view": "workflows", "workspace": "workspace_api", "select": "all", "title": "Hand off with|*context packets*", "sub": "Group related chats, build a briefing and send it to another assistant.", "scale": "0.92", "pills": "0"}),
    ("store-5-private", (1280, 800), {"view": "settings", "title": "Free. Private.|*No account.*", "sub": "Everything stays in your browser. No servers, no tracking, no licence keys.", "scale": "0.92"}),
]


def find_chrome():
    candidates = [
        os.environ.get("CHROME"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chrome"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    sys.exit("Chrome not found — set the CHROME environment variable to the executable path.")


def port_open(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_server():
    """Serve the repo root; reuse a server that is already running on PORT."""
    if port_open(PORT):
        return None
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if port_open(PORT):
            return proc
        time.sleep(0.1)
    proc.kill()
    sys.exit("Could not start the local http server.")


def render(chrome, name, size, params, profile_dir):
    w, h = size
    query = urllib.parse.urlencode({"w": w, "h": h, **params})
    url = f"http://127.0.0.1:{PORT}/tools/marketing/hero.html?{query}"
    raw = os.path.join(profile_dir, f"{name}.png")
    cmd = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        f"--user-data-dir={os.path.join(profile_dir, 'profile')}",
        "--force-device-scale-factor=1",
        f"--window-size={w},{h}",
        "--virtual-time-budget=10000",
        f"--screenshot={raw}",
        url,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    img = Image.open(raw).convert("RGB")  # 24-bit, no alpha (Store requirement)
    if img.size != (w, h):
        img = img.crop((0, 0, w, h))
    png = os.path.join(OUT, f"{name}-{w}x{h}.png")
    jpg = os.path.join(OUT, f"{name}-{w}x{h}.jpg")
    img.save(png, optimize=True)
    img.save(jpg, quality=92, optimize=True, progressive=True)
    return png, jpg


def main():
    chrome = find_chrome()
    os.makedirs(OUT, exist_ok=True)
    server = start_server()
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/tools/marketing/hero.html", timeout=5).read()
        with tempfile.TemporaryDirectory() as tmp:
            for name, size, params in SLIDES:
                png, jpg = render(chrome, name, size, params, tmp)
                print(f"wrote {os.path.relpath(png, ROOT)}  ({os.path.getsize(png) // 1024} KB)  + .jpg ({os.path.getsize(jpg) // 1024} KB)")
    finally:
        if server:
            server.kill()


if __name__ == "__main__":
    main()
