"""检查桌面客户端的同步状态和触发机制"""
import os
import sys
import json
import sqlite3
import subprocess
from datetime import datetime

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
YNOTE_DIR = os.path.join(APPDATA, "ynote-desktop")

print("=" * 60)
print("  1. 桌面客户端进程状态")
print("=" * 60)
result = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq ynote*", "/FO", "LIST"],
    capture_output=True, text=True
)
print(result.stdout or "  未找到进程")
result2 = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq YoudaoNote*", "/FO", "LIST"],
    capture_output=True, text=True
)
print(result2.stdout or "  未找到进程")

print("=" * 60)
print("  2. 桌面客户端安装路径和可执行文件")
print("=" * 60)
local_appdata = os.environ.get("LOCALAPPDATA", "")
possible_paths = [
    os.path.join(local_appdata, "ynote-desktop"),
    os.path.join(local_appdata, "Programs", "ynote-desktop"),
    os.path.join(os.environ.get("PROGRAMFILES", ""), "ynote-desktop"),
    os.path.join(APPDATA, "ynote-desktop"),
]
for p in possible_paths:
    if os.path.isdir(p):
        print(f"  存在: {p}")
        for f in os.listdir(p):
            if f.endswith(('.exe', '.json', '.yml', '.yaml')):
                print(f"    {f}")
    else:
        print(f"  不存在: {p}")

print("\n" + "=" * 60)
print("  3. note 表最近修改时间 (判断数据新鲜度)")
print("=" * 60)
conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()
cur.execute("SELECT MAX(modifyTime) FROM note WHERE del = 0")
max_mtime = cur.fetchone()[0]
if max_mtime and max_mtime > 1e12:
    max_mtime_s = max_mtime / 1000
else:
    max_mtime_s = max_mtime
if max_mtime_s:
    dt = datetime.fromtimestamp(max_mtime_s)
    age_hours = (datetime.now() - dt).total_seconds() / 3600
    print(f"  最新 modifyTime: {dt} ({age_hours:.1f} 小时前)")
else:
    print("  无数据")

cur.execute("""
    SELECT title, modifyTime FROM note WHERE del = 0
    ORDER BY modifyTime DESC LIMIT 5
""")
print("  最近修改的 5 条:")
for title, mt in cur.fetchall():
    if mt and mt > 1e12:
        mt = mt / 1000
    print(f"    {datetime.fromtimestamp(mt).strftime('%Y-%m-%d %H:%M')}  {title}")

print("\n" + "=" * 60)
print("  4. root 表 version (同步版本号)")
print("=" * 60)
cur.execute("SELECT * FROM root LIMIT 1")
row = cur.fetchone()
if row:
    cols = [d[0] for d in cur.description]
    for c, v in zip(cols, row):
        if isinstance(v, str) and len(v) > 80:
            v = v[:80] + "..."
        print(f"    {c}: {v}")
conn.close()

print("\n" + "=" * 60)
print("  5. setting.json 中的同步相关配置")
print("=" * 60)
setting_path = os.path.join(YNOTE_DIR, "setting.json")
if os.path.exists(setting_path):
    with open(setting_path, "r", encoding="utf-8") as f:
        settings = json.load(f)
    for key in sorted(settings.keys()):
        val = settings[key]
        if isinstance(val, str) and len(val) > 80:
            val = val[:80] + "..."
        if isinstance(val, dict):
            val = json.dumps(val, ensure_ascii=False)[:100] + "..."
        print(f"    {key}: {val}")
else:
    print("  setting.json 不存在")

print("\n" + "=" * 60)
print("  6. 检查桌面客户端的快捷方式和启动参数")
print("=" * 60)
startup_dir = os.path.join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
if os.path.isdir(startup_dir):
    for f in os.listdir(startup_dir):
        if "ynote" in f.lower() or "youdao" in f.lower() or "note" in f.lower():
            print(f"  开机启动项: {f}")
    else:
        print(f"  开机启动目录无有道相关项")

desktop_dir = os.path.join(os.environ.get("USERPROFILE", ""), "Desktop")
for d in [desktop_dir, os.path.join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")]:
    if os.path.isdir(d):
        for root_dir, dirs, files in os.walk(d):
            for f in files:
                if ("ynote" in f.lower() or "youdao" in f.lower()) and f.endswith(".lnk"):
                    full = os.path.join(root_dir, f)
                    print(f"  快捷方式: {full}")
