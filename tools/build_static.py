"""Build frontend/engine/app.zip, the Python backend bundle that the GitHub Pages edition runs in the browser.

Run from the project root after changing anything under backend/:

    python tools/build_static.py

The zip is committed to the repository (GitHub Pages cannot run a build step here), and a test checks that it is
up to date. It holds the unchanged backend package, the shim that serves requests inside the browser, the PDF
icons and the ₹-capable PDF font.
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "frontend" / "engine" / "app.zip"


def bundle_files() -> dict[str, Path]:
    files: dict[str, Path] = {}
    for path in sorted((ROOT / "backend").rglob("*.py")):
        files[path.relative_to(ROOT).as_posix()] = path
    for path in sorted((ROOT / "frontend" / "assets" / "icons").glob("*.png")):
        files[path.relative_to(ROOT).as_posix()] = path
    for path in sorted((ROOT / "frontend" / "engine" / "fonts").glob("*.ttf")):
        files[f"fonts/{path.name}"] = path
    files["shim.py"] = ROOT / "frontend" / "engine" / "shim.py"
    return files


def build() -> Path:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(TARGET, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path in bundle_files().items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # fixed timestamp: reproducible output
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    return TARGET


def is_current() -> bool:
    if not TARGET.exists():
        return False
    with zipfile.ZipFile(TARGET) as archive:
        expected = bundle_files()
        if set(archive.namelist()) != set(expected):
            return False
        return all(archive.read(name) == path.read_bytes() for name, path in expected.items())


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0 if is_current() else 1)
    out = build()
    print(f"Built {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
