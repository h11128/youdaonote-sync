"""检查有道云笔记桌面客户端本地数据"""
import os
import sys
import sqlite3
import json

APPDATA = os.environ["APPDATA"]
YNOTE_DIR = os.path.join(APPDATA, "ynote-desktop")
COOKIES_DB = os.path.join(YNOTE_DIR, "Network", "Cookies")
USER_DB = os.path.join(YNOTE_DIR, "h11128@163.com", "ynote-data", "h11128@163.com.db")
CONTENT_DB = os.path.join(YNOTE_DIR, "h11128@163.com", "ynote-data", "h11128@163.com-content.db")
SETTING_JSON = os.path.join(YNOTE_DIR, "setting.json")

print("=" * 60)
print("1. Cookies 数据库")
print("=" * 60)
try:
    conn = sqlite3.connect(f"file:{COOKIES_DB}?mode=ro", uri=True)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print(f"  Tables: {tables}")
    cur.execute("SELECT name, host_key, path, expires_utc, is_httponly, is_secure, LENGTH(encrypted_value) FROM cookies WHERE host_key LIKE '%youdao%'")
    rows = cur.fetchall()
    print(f"  Youdao cookies: {len(rows)}")
    for r in rows:
        name, host, path, expires, httponly, secure, enc_len = r
        print(f"    {name:30s} host={host:30s} expires={expires} enc_len={enc_len}")
    conn.close()
except Exception as e:
    print(f"  Error: {e}")

print()
print("=" * 60)
print("2. 用户数据库 (h11128@163.com.db)")
print("=" * 60)
try:
    conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print(f"  Tables ({len(tables)}): {tables[:20]}")
    if len(tables) > 20:
        print(f"    ... and {len(tables) - 20} more")

    for t in ['note', 'folder', 'file', 'note_file', 'dir', 'directory']:
        if t in tables:
            cur.execute(f"SELECT COUNT(*) FROM [{t}]")
            cnt = cur.fetchone()[0]
            cur.execute(f"PRAGMA table_info([{t}])")
            cols = [r[1] for r in cur.fetchall()]
            print(f"  {t}: {cnt} rows, columns: {cols}")
            if cnt > 0:
                cur.execute(f"SELECT * FROM [{t}] LIMIT 2")
                for row in cur.fetchall():
                    print(f"    sample: {str(row)[:200]}")
    conn.close()
except Exception as e:
    print(f"  Error: {e}")

print()
print("=" * 60)
print("3. Content 数据库")
print("=" * 60)
try:
    conn = sqlite3.connect(f"file:{CONTENT_DB}?mode=ro", uri=True)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print(f"  Tables ({len(tables)}): {tables[:20]}")
    for t in tables[:5]:
        cur.execute(f"SELECT COUNT(*) FROM [{t}]")
        cnt = cur.fetchone()[0]
        cur.execute(f"PRAGMA table_info([{t}])")
        cols = [r[1] for r in cur.fetchall()]
        print(f"  {t}: {cnt} rows, columns: {cols[:10]}")
    conn.close()
except Exception as e:
    print(f"  Error: {e}")

print()
print("=" * 60)
print("4. setting.json (摘要)")
print("=" * 60)
try:
    with open(SETTING_JSON, "r", encoding="utf-8") as f:
        setting = json.load(f)
    for key in ['token', 'cstk', 'cookie', 'session', 'auth', 'user', 'login', 'account']:
        for k, v in setting.items():
            if key in k.lower():
                val = str(v)
                print(f"  {k}: {val[:80]}{'...' if len(val) > 80 else ''}")
    print(f"  Total keys: {len(setting)}")
    print(f"  Top-level keys: {list(setting.keys())[:20]}")
except Exception as e:
    print(f"  Error: {e}")

print()
print("=" * 60)
print("5. Local Storage / Session Storage")
print("=" * 60)
ls_dir = os.path.join(YNOTE_DIR, "Local Storage", "leveldb")
if os.path.exists(ls_dir):
    files = os.listdir(ls_dir)
    print(f"  Local Storage files: {files}")
    for f in files:
        if f.endswith('.log') or f.endswith('.ldb'):
            fp = os.path.join(ls_dir, f)
            size = os.path.getsize(fp)
            print(f"    {f}: {size} bytes")
            if size < 10000:
                try:
                    with open(fp, 'rb') as fh:
                        data = fh.read()
                    text = data.decode('utf-8', errors='replace')
                    for line in text.split('\n'):
                        if any(kw in line.lower() for kw in ['token', 'cstk', 'session', 'cookie', 'auth']):
                            print(f"      >>> {line[:120]}")
                except Exception:
                    pass

ss_dir = os.path.join(YNOTE_DIR, "Session Storage")
if os.path.exists(ss_dir):
    files = os.listdir(ss_dir)
    print(f"  Session Storage files: {files}")
