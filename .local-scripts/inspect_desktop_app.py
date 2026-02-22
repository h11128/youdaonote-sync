"""检查桌面客户端的可利用接口"""
import os
import subprocess
import json

INSTALL_DIR = r"C:\Program Files\ynote-desktop"
APPDATA_DIR = os.path.join(os.environ["APPDATA"], "ynote-desktop")

print("=" * 60)
print("  1. 安装目录内容")
print("=" * 60)
if os.path.isdir(INSTALL_DIR):
    for f in sorted(os.listdir(INSTALL_DIR)):
        fp = os.path.join(INSTALL_DIR, f)
        if os.path.isfile(fp):
            sz = os.path.getsize(fp)
            print(f"  {f:<40} {sz:>12,} bytes")
        else:
            print(f"  {f}/ (dir)")

print("\n" + "=" * 60)
print("  2. 检查 resources/app.asar (Electron 打包文件)")
print("=" * 60)
resources_dir = os.path.join(INSTALL_DIR, "resources")
if os.path.isdir(resources_dir):
    for f in sorted(os.listdir(resources_dir)):
        fp = os.path.join(resources_dir, f)
        sz = os.path.getsize(fp) if os.path.isfile(fp) else 0
        print(f"  {f:<40} {sz:>12,} bytes" if os.path.isfile(fp) else f"  {f}/ (dir)")
else:
    print("  resources/ 不存在")

print("\n" + "=" * 60)
print("  3. 检查命令行参数 (--help)")
print("=" * 60)
exe = os.path.join(INSTALL_DIR, "有道云笔记.exe")
try:
    result = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=5)
    print(f"  stdout: {result.stdout[:500] if result.stdout else '(empty)'}")
    print(f"  stderr: {result.stderr[:500] if result.stderr else '(empty)'}")
except subprocess.TimeoutExpired:
    print("  超时（可能直接启动了 GUI）")
except Exception as e:
    print(f"  错误: {e}")

print("\n" + "=" * 60)
print("  4. 检查 protocol handler (ynote://)")
print("=" * 60)
import winreg
for proto in ["ynote", "youdaonote", "ynotedesktop"]:
    try:
        key = winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, proto)
        val = winreg.QueryValue(key, "")
        print(f"  {proto}:// → {val}")
        try:
            cmd_key = winreg.OpenKey(key, r"shell\open\command")
            cmd_val = winreg.QueryValue(cmd_key, "")
            print(f"    command: {cmd_val}")
        except Exception:
            pass
        winreg.CloseKey(key)
    except FileNotFoundError:
        print(f"  {proto}:// → 未注册")

print("\n" + "=" * 60)
print("  5. 检查本地端口监听 (Electron DevTools / IPC)")
print("=" * 60)
result = subprocess.run(
    ["netstat", "-ano"],
    capture_output=True, text=True
)
for line in result.stdout.splitlines():
    if "127.0.0.1" in line and "LISTENING" in line:
        parts = line.split()
        port = parts[1].split(":")[-1] if len(parts) > 1 else "?"
        pid = parts[-1] if parts else "?"
        if int(port) > 1024 and int(port) < 65535:
            pass  # 太多了，只看 ynote 进程的

print("\n" + "=" * 60)
print("  6. versioning.json (更新/同步配置)")
print("=" * 60)
ver_path = os.path.join(APPDATA_DIR, "versioning.json")
if os.path.exists(ver_path):
    with open(ver_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"  {json.dumps(data, indent=2, ensure_ascii=False)[:800]}")

print("\n" + "=" * 60)
print("  7. browser-settings.json")
print("=" * 60)
bs_path = os.path.join(APPDATA_DIR, "browser-settings.json")
if os.path.exists(bs_path):
    with open(bs_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"  {json.dumps(data, indent=2, ensure_ascii=False)[:800]}")

print("\n" + "=" * 60)
print("  8. 同步 API 接口调研 — 增量同步 API")
print("=" * 60)
print("  桌面客户端用增量同步 API 更新本地 DB：")
print("  GET /yws/api/personal/sync?version={local_version}&keyfrom=web&cstk={cstk}")
print("  这个 API 返回 local_version 之后的所有变更条目")
print("  如果我们能直接调这个 API，就能自己更新 SQLite")
