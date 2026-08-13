#!/usr/bin/env python3
"""Official checklist before saying unique diary handwriting is lost.

Git / VoiceLog alone is not exhaustive. Youdao desktop backupNote often
still has deleted cloud .note versions.

Exit 2: desktop unavailable — MUST NOT claim lost.
Exit 0: desktop was checked (read VERDICT).
Exit 64: bad args.

Usage:
  python scripts/recover-diary-sources.py --title 2026年8月11日
  python scripts/recover-diary-sources.py --title 2026年8月11日 --extract-dir OUT
"""

from __future__ import annotations

import argparse
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

RULE = (
    "RULE: git-only search is not exhaustive; "
    "do not say unique handwriting was never written"
)


def verdict_for(
    rows: list[tuple[str, str, int, int]],
    version_count: int,
) -> str:
    if not rows:
        return "desktop_checked_no_matching_rows"
    if version_count <= 0:
        return "desktop_rows_no_backup_versions"
    return "backup_versions_exist"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", required=True)
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--extract-dir", default="")
    args = parser.parse_args()

    print(f"title: {args.title}")
    print(RULE)

    try:
        datas = resolve_data_dirs(args.data_dir or None)
        paired: list[tuple[Path, tuple[str, str, int, int]]] = []
        dbs: list[Path] = []
        for data in datas:
            db = note_db(data)
            dbs.append(db)
            for row in note_rows(db, args.title):
                paired.append((data, row))
    except DesktopUnavailable as exc:
        print("desktop_backup: unavailable")
        print(f"reason: {exc}")
        print("VERDICT: desktop_unavailable_cannot_claim_lost")
        return 2

    rows = [row for _data, row in paired]
    print("desktop_backup: checked")
    print(f"desktop_db: {'; '.join(str(db) for db in dbs)}")
    print(f"desktop_rows: {len(rows)}")
    print(f"desktop_deleted_rows: {sum(1 for r in rows if r[2])}")

    extract = Path(args.extract_dir) if args.extract_dir else None
    if extract:
        extract.mkdir(parents=True, exist_ok=True)

    version_count = 0
    best: tuple[str, int, int] | None = None
    for data, (file_id, title, deleted, _mtime) in paired:
        backup = backup_dir(data, file_id)
        versions = list_versions(backup)
        version_count += len(versions)
        print(
            f"row: fileId={file_id} title={title} del={deleted} "
            f"versions={len(versions)}"
        )
        richest = richest_version(versions)
        if richest is None:
            continue
        if best is None or richest[1] > best[2]:
            best = (file_id, richest[0], richest[1])
        if extract:
            texts = read_version_texts(backup, richest[0])
            out = extract / f"{file_id}-v{richest[0]}.md"
            out.write_text("\n".join(texts) + "\n", encoding="utf-8")
            print(f"extracted: {out} chars={sum(len(t) for t in texts)}")

    richest_line = (
        f"richest: fileId={best[0]} v={best[1]} bytes={best[2]}"
        if best
        else "richest: none"
    )

    print(f"desktop_version_count: {version_count}")
    print(richest_line)
    print(f"VERDICT: {verdict_for(rows, version_count)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
