"""Quick test to debug SyncLogIntegration hang."""
import os, sys, tempfile, shutil
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock

tmpdir = tempfile.mkdtemp()
local_dir = os.path.join(tmpdir, "notes")
os.makedirs(local_dir)

from src.sync.metadata import SyncMetadata
meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

print("Creating SyncManager...")
api = MagicMock()
api.get_root_id.return_value = "root"

from src.sync.engine import SyncManager
mgr = SyncManager(api, local_dir, metadata=meta)
print("SyncManager created OK")

from src.sync.utils import SyncAction, SyncItem
p = os.path.join(local_dir, "test.md")
with open(p, "w") as f:
    f.write("hello")
meta.set_file_info("test.md", "f1", 100, content_hash="old_hash")
meta.save()

item = SyncItem(
    relative_path="test.md", local_path=p, cloud_id="f1",
    cloud_parent_id="root", local_mtime=200, cloud_mtime=200,
    is_dir=False, action=SyncAction.DOWNLOAD, cloud_name="test.md",
    domain=1, cloud_ctime=50,
)
print("Calling _record_file_change...")
mgr._record_file_change(item, "downloaded", local_mtime=200, content_hash="new_hash")
print("Done!")
mgr.metadata.save()

logs = meta.get_sync_log(path="test.md")
print(f"Logs: {logs}")

meta.close()
shutil.rmtree(tmpdir, ignore_errors=True)
print("PASS")
