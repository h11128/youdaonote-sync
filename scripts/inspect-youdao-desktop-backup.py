#!/usr/bin/env python3
"""List / extract Youdao desktop backupNote versions for a diary title.

The official app keeps gzip'd NOTE JSON snapshots under
%APPDATA%/ynote-desktop/<account>/ynote-data/backupNote/<fileId>/.
Deleted cloud .note files often still have these local versions.

Never deletes. Does not touch sync_metadata.db.

Usage:
  python scripts/inspect-youdao-desktop-backup.py --title 2026年8月11日
  python scripts/inspect-youdao-desktop-backup.py --title 2026年8月11日 --extract-dir OUT
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sqlite3
import sys
from pathlib import Path


def desktop_data_dir() -> Path:
    appdata = os.environ.get("APPDATA", "")
    if not appdata:
        raise SystemExit("APPDATA missing")
    root = Path(appdata) / "ynote-desktop"
    if not root.is_dir():
        raise SystemExit(f"no Youdao desktop dir: {root}")
    for child in root.iterdir():
        data = child / "ynote-data"
        if data.is_dir() and (data / f"{child.name}.db").is_file():
            return data
    raise SystemExit(f"no account ynote-data under {root}")


def note_rows(db: Path, title_sub: str) -> list[tuple[str, str, int, int]]:
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    cur = con.cursor()
    rows = list(
        cur.execute(
            "SELECT fileId, title, del, modifyTime FROM note WHERE title LIKE ?",
            (f"%{title_sub}%",),
        )
    )
    con.close()
    return [(str(a), str(b), int(c or 0), int(d or 0)) for a, b, c, d in rows]


def extract_texts(obj: object, out: list[str]) -> None:
    if isinstance(obj, dict):
        text = obj.get("8")
        if isinstance(text, str) and text:
            out.append(text)
        for val in obj.values():
            extract_texts(val, out)
    elif isinstance(obj, list):
        for item in obj:
            extract_texts(item, out)


def list_versions(backup_dir: Path) -> list[tuple[int, int]]:
    versions: list[tuple[int, int]] = []
    for child in backup_dir.iterdir():
        if child.name.endswith(".index") or not child.name.isdigit():
            continue
        versions.append((int(child.name), child.stat().st_size))
    versions.sort()
    return versions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", required=True, help="title substring, e.g. 2026年8月11日")
    parser.add_argument("--extract-dir", default="", help="write decompressed md snapshots")
    args = parser.parse_args()

    data = desktop_data_dir()
    db = data / f"{data.parent.name}.db"
    rows = note_rows(db, args.title)
    if not rows:
        print(f"no note rows matching {args.title!r} in {db}")
        return 1

    print("fileId\ttitle\tdel\tmtime")
    for file_id, title, deleted, mtime in rows:
        print(f"{file_id}\t{title}\tdel={deleted}\t{mtime}")

    extract = Path(args.extract_dir) if args.extract_dir else None
    if extract:
        extract.mkdir(parents=True, exist_ok=True)

    for file_id, title, deleted, _mtime in rows:
        backup = data / "backupNote" / file_id
        print(f"\n==== {title} {file_id} del={deleted} ====")
        if not backup.is_dir():
            print("no backupNote dir")
            continue
        versions = list_versions(backup)
        print("versions", [(n, sz) for n, sz in versions])
        if not extract or not versions:
            continue
        richest = max(versions, key=lambda item: item[1])
        raw = gzip.decompress((backup / str(richest[0])).read_bytes())
        texts: list[str] = []
        extract_texts(json.loads(raw.decode("utf-8")), texts)
        out = extract / f"{file_id}-v{richest[0]}.md"
        out.write_text("\n".join(texts) + "\n", encoding="utf-8")
        print("extracted", out, "chars", sum(len(t) for t in texts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
