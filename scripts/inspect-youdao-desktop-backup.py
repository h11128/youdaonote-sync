#!/usr/bin/env python3
"""List / extract Youdao desktop backupNote versions for a diary title.

Usage:
  python scripts/inspect-youdao-desktop-backup.py --title 2026年8月11日
  python scripts/inspect-youdao-desktop-backup.py --title 2026年8月11日 --extract-dir OUT
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from youdao_desktop_backup import (
    DesktopUnavailable,
    backup_dir,
    list_versions,
    note_db,
    note_rows,
    read_version_texts,
    resolve_data_dirs,
    richest_version,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--title", required=True, help="title substring, e.g. 2026年8月11日"
    )
    parser.add_argument(
        "--extract-dir", default="", help="write decompressed md snapshots"
    )
    parser.add_argument("--data-dir", default="", help="override ynote-data path")
    args = parser.parse_args()

    try:
        datas = resolve_data_dirs(args.data_dir or None)
        paired: list[tuple[Path, tuple[str, str, int, int]]] = []
        for data in datas:
            for row in note_rows(note_db(data), args.title):
                paired.append((data, row))
    except DesktopUnavailable as exc:
        print(exc, file=sys.stderr)
        return 2

    if not paired:
        print(f"no note rows matching {args.title!r}")
        return 1

    print("fileId\ttitle\tdel\tmtime")
    for _data, (file_id, title, deleted, mtime) in paired:
        print(f"{file_id}\t{title}\tdel={deleted}\t{mtime}")

    extract = Path(args.extract_dir) if args.extract_dir else None
    if extract:
        extract.mkdir(parents=True, exist_ok=True)

    for data, (file_id, title, deleted, _mtime) in paired:
        backup = backup_dir(data, file_id)
        print(f"\n==== {title} {file_id} del={deleted} ====")
        if not backup.is_dir():
            print("no backupNote dir")
            continue
        versions = list_versions(backup)
        print("versions", [(n, sz) for n, sz in versions])
        if not extract or not versions:
            continue
        richest = richest_version(versions)
        if richest is None:
            continue
        texts = read_version_texts(backup, richest[0])
        out = extract / f"{file_id}-v{richest[0]}.md"
        out.write_text("\n".join(texts) + "\n", encoding="utf-8")
        print("extracted", out, "chars", sum(len(t) for t in texts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
