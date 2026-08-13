"""Read-only helpers for Youdao desktop note DB + backupNote.

The official desktop app keeps gzip'd NOTE JSON under
%APPDATA%/ynote-desktop/<account>/ynote-data/backupNote/<fileId>/.
Deleted cloud .note files often still have these local versions.

Never deletes. Does not touch youdaonote-sync sync_metadata.db.
"""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
from pathlib import Path


class DesktopUnavailable(RuntimeError):
    """Desktop data dir or DB is missing; recovery cannot claim 'lost'."""


def resolve_data_dir(explicit: str | None = None) -> Path:
    dirs = resolve_data_dirs(explicit)
    return dirs[0]


def resolve_data_dirs(explicit: str | None = None) -> list[Path]:
    if explicit:
        path = Path(explicit)
        if not path.is_dir():
            raise DesktopUnavailable(f"data dir missing: {path}")
        return [path]
    env = os.environ.get("YNOTE_DESKTOP_DATA", "").strip()
    if env:
        path = Path(env)
        if not path.is_dir():
            raise DesktopUnavailable(f"YNOTE_DESKTOP_DATA missing: {path}")
        return [path]
    return discover_all_data_dirs()


def discover_all_data_dirs() -> list[Path]:
    appdata = os.environ.get("APPDATA", "")
    if not appdata:
        raise DesktopUnavailable("APPDATA missing")
    root = Path(appdata) / "ynote-desktop"
    if not root.is_dir():
        raise DesktopUnavailable(f"no Youdao desktop dir: {root}")
    found: list[Path] = []
    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        data = child / "ynote-data"
        db = data / f"{child.name}.db"
        if data.is_dir() and db.is_file():
            found.append(data)
    if not found:
        raise DesktopUnavailable(f"no account ynote-data under {root}")
    return found


def discover_data_dir() -> Path:
    return discover_all_data_dirs()[0]


def note_db(data: Path) -> Path:
    return data / f"{data.parent.name}.db"


def note_rows(db: Path, title_sub: str) -> list[tuple[str, str, int, int]]:
    if not db.is_file():
        raise DesktopUnavailable(f"desktop db missing: {db}")
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        rows = list(
            con.execute(
                "SELECT fileId, title, del, modifyTime FROM note WHERE title LIKE ?",
                (f"%{title_sub}%",),
            )
        )
    finally:
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
    if not backup_dir.is_dir():
        return versions
    for child in backup_dir.iterdir():
        if child.name.endswith(".index") or not child.name.isdigit():
            continue
        versions.append((int(child.name), child.stat().st_size))
    versions.sort()
    return versions


def backup_dir(data: Path, file_id: str) -> Path:
    return data / "backupNote" / file_id


def richest_version(versions: list[tuple[int, int]]) -> tuple[int, int] | None:
    if not versions:
        return None
    return max(versions, key=lambda item: item[1])


def read_version_texts(backup: Path, version: int) -> list[str]:
    raw = gzip.decompress((backup / str(version)).read_bytes())
    texts: list[str] = []
    extract_texts(json.loads(raw.decode("utf-8")), texts)
    return texts
