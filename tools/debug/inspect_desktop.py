"""
有道云笔记桌面客户端本地数据检查工具。

子命令:
  app       安装路径、protocol handler、versioning
  data      DB 表结构、文件统计、磁盘布局
  sync      进程状态、同步版本号、最近修改
  format    file/ 目录中的文件格式检测
  domain    domain=0/1 分布、缓存和 content.db 覆盖率

用法:
  python tools/debug/inspect_desktop.py app
  python tools/debug/inspect_desktop.py data
  python tools/debug/inspect_desktop.py sync
  python tools/debug/inspect_desktop.py format
  python tools/debug/inspect_desktop.py domain
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.sync.desktop_data import find_desktop_data_dir

APPDATA = os.environ.get("APPDATA", "")
YNOTE_DIR = os.path.join(APPDATA, "ynote-desktop")
INSTALL_DIR = r"C:\Program Files\ynote-desktop"


def _find_user_dir():
    d = find_desktop_data_dir()
    if d:
        return d
    for name in os.listdir(YNOTE_DIR) if os.path.isdir(YNOTE_DIR) else []:
        candidate = os.path.join(YNOTE_DIR, name, "ynote-data")
        if os.path.isdir(candidate):
            return candidate
    return None


def _open_db(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _section(title):
    print(f"\n{'=' * 70}\n  {title}\n{'=' * 70}")


# ===== app =====

def cmd_app(_args):
    _section("安装目录")
    if os.path.isdir(INSTALL_DIR):
        for f in sorted(os.listdir(INSTALL_DIR)):
            fp = os.path.join(INSTALL_DIR, f)
            if os.path.isfile(fp):
                print(f"  {f:<40} {os.path.getsize(fp):>12,} bytes")
            else:
                print(f"  {f}/ (dir)")
    else:
        print(f"  {INSTALL_DIR} 不存在")

    _section("Protocol handler")
    try:
        import winreg
        for proto in ["ynote", "youdaonote", "ynotedesktop"]:
            try:
                key = winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, proto)
                print(f"  {proto}:// → {winreg.QueryValue(key, '')}")
                try:
                    cmd_key = winreg.OpenKey(key, r"shell\open\command")
                    print(f"    command: {winreg.QueryValue(cmd_key, '')}")
                except Exception:
                    pass
                winreg.CloseKey(key)
            except FileNotFoundError:
                print(f"  {proto}:// → 未注册")
    except ImportError:
        print("  (非 Windows 环境，跳过)")

    _section("versioning.json")
    ver_path = os.path.join(YNOTE_DIR, "versioning.json")
    if os.path.exists(ver_path):
        with open(ver_path, "r", encoding="utf-8") as f:
            print(f"  {json.dumps(json.load(f), indent=2, ensure_ascii=False)[:800]}")
    else:
        print("  不存在")


# ===== data =====

def cmd_data(_args):
    user_dir = _find_user_dir()
    if not user_dir:
        print("未找到桌面客户端数据目录"); return

    db_files = [f for f in os.listdir(user_dir) if f.endswith(".db")]
    _section(f"数据目录: {user_dir}")
    print(f"  DB 文件: {db_files}")

    main_db = next((os.path.join(user_dir, f) for f in db_files
                     if f.endswith(".db") and "-" not in f), None)
    if not main_db:
        print("  未找到主数据库"); return

    conn = _open_db(main_db)
    cur = conn.cursor()

    _section("note 表")
    cur.execute("SELECT COUNT(*) FROM note")
    print(f"  总计: {cur.fetchone()[0]} 条")
    cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND dir = 0")
    print(f"  活跃文件: {cur.fetchone()[0]} 条")
    cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND dir = 1")
    print(f"  活跃目录: {cur.fetchone()[0]} 条")

    _section("note_book 表")
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='note_book'")
    if cur.fetchone():
        cur.execute("SELECT COUNT(*) FROM note_book WHERE del = 0")
        print(f"  总计: {cur.fetchone()[0]} 条")
    else:
        print("  表不存在")

    _section("磁盘文件结构")
    for subdir in ['file', 'resource', 'resourceFile', 'backupNote', 'backupDb']:
        d = os.path.join(user_dir, subdir)
        if os.path.isdir(d):
            total = sum(len(f) for _, _, f in os.walk(d))
            size = sum(os.path.getsize(os.path.join(r, f))
                       for r, _, fs in os.walk(d) for f in fs)
            print(f"  {subdir}/: {total} files, {size / 1024:.0f} KB")
        else:
            print(f"  {subdir}/: not found")

    conn.close()


# ===== sync =====

def cmd_sync(_args):
    _section("桌面客户端进程")
    for img in ["ynote*", "YoudaoNote*"]:
        r = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {img}", "/FO", "LIST"],
                           capture_output=True, text=True)
        out = r.stdout.strip()
        if "INFO:" not in out:
            print(f"  {out[:300]}")
    if not any("INFO:" not in subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {img}", "/FO", "LIST"],
            capture_output=True, text=True).stdout for img in ["ynote*", "YoudaoNote*"]):
        print("  未找到进程")

    user_dir = _find_user_dir()
    if not user_dir:
        print("未找到数据目录"); return

    main_db = next((os.path.join(user_dir, f) for f in os.listdir(user_dir)
                     if f.endswith(".db") and "-" not in f), None)
    if not main_db:
        return

    conn = _open_db(main_db)
    cur = conn.cursor()

    _section("最近修改 (note 表)")
    cur.execute("SELECT title, modifyTime FROM note WHERE del = 0 ORDER BY modifyTime DESC LIMIT 5")
    for title, mt in cur.fetchall():
        if mt and mt > 1e12:
            mt = mt / 1000
        ts = datetime.fromtimestamp(mt).strftime("%Y-%m-%d %H:%M") if mt else "?"
        print(f"  {ts}  {title}")

    _section("root 表 (同步版本号)")
    cur.execute("SELECT * FROM root LIMIT 1")
    row = cur.fetchone()
    if row:
        for c, v in zip([d[0] for d in cur.description], row):
            if isinstance(v, str) and len(v) > 80:
                v = v[:80] + "..."
            print(f"  {c}: {v}")

    conn.close()

    _section("setting.json 关键配置")
    setting_path = os.path.join(YNOTE_DIR, "setting.json")
    if os.path.exists(setting_path):
        with open(setting_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        for key in ["lastSyncTime", "currentUser", "version", "autoSync"]:
            if key in settings:
                val = str(settings[key])[:80]
                print(f"  {key}: {val}")


# ===== format =====

def cmd_format(_args):
    user_dir = _find_user_dir()
    if not user_dir:
        print("未找到数据目录"); return

    file_dir = os.path.join(user_dir, "file")
    main_db = next((os.path.join(user_dir, f) for f in os.listdir(user_dir)
                     if f.endswith(".db") and "-" not in f), None)
    if not main_db or not os.path.isdir(file_dir):
        print("  file/ 或主 DB 不存在"); return

    conn = _open_db(main_db)
    cur = conn.cursor()

    for label, where in [(".md (domain=1)", "title LIKE '%.md'"),
                          (".note (domain=0)", "title LIKE '%.note'")]:
        _section(f"{label} 文件的磁盘格式")
        cur.execute(f"SELECT fileId, title, domain, size FROM note WHERE del = 0 AND {where} "
                    f"ORDER BY modifyTime DESC LIMIT 3")
        for row in cur.fetchall():
            fid = row["fileId"]
            bucket = fid[0].lower()
            path = os.path.join(file_dir, bucket, fid)
            exists = os.path.exists(path)
            print(f"\n  {row['title']} (domain={row['domain']}, size={row['size']})")
            print(f"  disk: {path}")
            print(f"  exists: {exists}")
            if exists:
                with open(path, "rb") as f:
                    raw = f.read(500)
                fmt = "Unknown"
                if raw[:5] == b'<?xml' or b'<note' in raw[:200]:
                    fmt = "XML/Note"
                elif raw[:1] == b'#' or raw[:3] == b'\xef\xbb\xbf':
                    fmt = "Markdown/Text"
                elif raw[:2] in (b'\x1f\x8b', b'\x78\x9c', b'\x78\x01'):
                    fmt = "Compressed"
                print(f"  format: {fmt}")
                try:
                    print(f"  preview: {raw[:300].decode('utf-8', errors='replace')[:200]}")
                except Exception:
                    print(f"  (binary)")

    conn.close()


# ===== domain =====

def cmd_domain(_args):
    user_dir = _find_user_dir()
    if not user_dir:
        print("未找到数据目录"); return

    main_db = next((os.path.join(user_dir, f) for f in os.listdir(user_dir)
                     if f.endswith(".db") and "-" not in f), None)
    if not main_db:
        return

    conn = _open_db(main_db)
    cur = conn.cursor()

    _section("domain 分布")
    cur.execute("SELECT domain, COUNT(*) FROM note WHERE del = 0 AND dir = 0 GROUP BY domain")
    total = 0
    for dom, cnt in cur.fetchall():
        label = {0: "XML/NOTE", 1: "Markdown"}.get(dom, f"unknown({dom})")
        print(f"  domain={dom} ({label}): {cnt}")
        total += cnt
    print(f"  总计: {total}")

    _section("fileId 前缀分布")
    cur.execute("SELECT SUBSTR(fileId, 1, 3) as prefix, COUNT(*) FROM note "
                "WHERE del = 0 GROUP BY prefix ORDER BY COUNT(*) DESC LIMIT 5")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]}")

    file_dir = os.path.join(user_dir, "file")
    if os.path.isdir(file_dir):
        _section("domain=1 文件的本地缓存覆盖率")
        cur.execute("SELECT fileId FROM note WHERE del = 0 AND domain = 1 AND dir = 0")
        md_ids = [r[0] for r in cur.fetchall()]
        cached = sum(1 for fid in md_ids
                     if os.path.exists(os.path.join(file_dir, fid[0].lower(), fid)))
        print(f"  有本地缓存: {cached}/{len(md_ids)}")
        print(f"  无本地缓存: {len(md_ids) - cached}/{len(md_ids)}")

    content_db = next((os.path.join(user_dir, f) for f in os.listdir(user_dir)
                       if f.endswith("-content.db")), None)
    if content_db and os.path.exists(content_db):
        _section("content.db 覆盖率")
        conn2 = _open_db(content_db)
        cur2 = conn2.cursor()
        cur2.execute("SELECT COUNT(*) FROM contenttable WHERE fileId LIKE 'WEB%'")
        web = cur2.fetchone()[0]
        cur2.execute("SELECT COUNT(*) FROM contenttable WHERE fileId NOT LIKE 'WEB%'")
        non_web = cur2.fetchone()[0]
        print(f"  WEB 前缀: {web}")
        print(f"  非 WEB:   {non_web}")
        conn2.close()

    conn.close()


# ===== main =====

def main():
    parser = argparse.ArgumentParser(description="有道云笔记桌面客户端数据检查")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("app", help="安装路径、protocol、versioning")
    sub.add_parser("data", help="DB 表结构、文件统计")
    sub.add_parser("sync", help="进程状态、同步版本号")
    sub.add_parser("format", help="file/ 中的文件格式检测")
    sub.add_parser("domain", help="domain 分布、缓存覆盖率")

    args = parser.parse_args()
    dispatch = {"app": cmd_app, "data": cmd_data, "sync": cmd_sync,
                "format": cmd_format, "domain": cmd_domain}

    if args.command is None:
        parser.print_help()
        return 1
    return dispatch[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
