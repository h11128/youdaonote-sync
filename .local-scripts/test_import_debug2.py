"""Debug: SyncManager creation."""
import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock
from src.sync.metadata import SyncMetadata
from src.sync.engine import SyncManager

tmpdir = tempfile.mkdtemp()
local_dir = os.path.join(tmpdir, "notes")
os.makedirs(local_dir)

meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

print("Creating MagicMock api...")
api = MagicMock()
api.get_root_id.return_value = "root"

print("Creating SyncManager...")
mgr = SyncManager(api, local_dir, metadata=meta)
print(f"SyncManager created: {mgr}")

meta.close()
import shutil
shutil.rmtree(tmpdir, ignore_errors=True)
print("DONE")
