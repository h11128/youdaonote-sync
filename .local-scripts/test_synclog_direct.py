"""Direct copy of SyncLogIntegrationTest."""
import os, sys, tempfile, shutil
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock
from src.sync.metadata import SyncMetadata
from src.sync.utils import SyncAction, SyncItem
from src.sync.engine import SyncManager

tmpdir = tempfile.mkdtemp()
meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
local_dir = os.path.join(tmpdir, "notes")
os.makedirs(local_dir, exist_ok=True)

api = MagicMock()
api.get_root_id.return_value = "root"
print("Step 1: Creating SyncManager...")
mgr = SyncManager(api, local_dir, metadata=meta)
print("Step 2: SyncManager created")

p = os.path.join(local_dir, "test.md")
with open(p, "w") as f:
    f.write("hello")
meta.set_file_info("test.md", "f1", 100, content_hash="old_hash")
meta.save()
print("Step 3: Metadata set")

item = SyncItem(
    relative_path="test.md", local_path=p, cloud_id="f1",
    cloud_parent_id="root", local_mtime=200, cloud_mtime=200,
    is_dir=False, action=SyncAction.DOWNLOAD, cloud_name="test.md",
    domain=1, cloud_ctime=50,
)
print("Step 4: Calling _record_file_change...")
mgr._record_file_change(item, "downloaded", local_mtime=200, content_hash="new_hash")
print("Step 5: Done with _record_file_change")
mgr.metadata.save()
print("Step 6: Saved")

logs = meta.get_sync_log(path="test.md")
print(f"Step 7: Logs = {logs}")
assert len(logs) >= 1
assert logs[0]["action"] == "downloaded"

meta.close()
shutil.rmtree(tmpdir, ignore_errors=True)
print("PASS")
