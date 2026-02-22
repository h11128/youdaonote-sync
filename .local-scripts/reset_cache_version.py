"""重置 scan cache version，强制下次全量扫描"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.sync.metadata import SyncMetadata

meta = SyncMetadata()
meta.set_state("last_cloud_version", "0")
meta.set_state("last_scan_time", "0")
meta.save()
print("已重置缓存 version 为 0")
meta.close()
