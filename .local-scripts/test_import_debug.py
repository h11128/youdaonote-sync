"""Debug: which import hangs?"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

print("1. importing metadata...")
from src.sync.metadata import SyncMetadata
print("2. importing utils...")
from src.sync.utils import SyncAction, SyncItem
print("3. importing engine...")
from src.sync.engine import SyncManager
print("4. All imports OK")
