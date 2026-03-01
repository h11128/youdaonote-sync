# Type-Driven Design Audit

Date: 2026-02-28

## Executive Summary

The codebase has **good enum/dataclass usage in the sync-decision layer** (SyncAction, SyncDirection, SyncItem, MergeResult, PendingMove) and **solid Protocol-based dependency inversion** (9 protocols in `protocols.py`). However, the **data layer is dominated by untyped dicts** — the "info dict" pattern flows through scanner → engine → decision → moves → dedup → metadata, carrying ~10 fields with zero compile-time structure. This is the single biggest type-safety gap.

### Stats at a Glance

| What exists | Count |
|---|---|
| dataclass | 4 (SyncItem, MergeResult, PendingMove, ChangedBlock) |
| Enum | 4 (SyncAction, SyncDirection, FileType, FileAction) |
| Protocol | 9 |
| TypedDict | 0 |
| NamedTuple | 0 |
| NewType | 0 |
| Functions with `Dict[str, Any]` or raw `Dict` | 40+ |
| Magic dict-key accesses (`info["id"]`, `stats["downloaded"]`, ...) | 100+ |
| Functions missing type hints entirely | 50+ |

---

## Finding 1: The "Info Dict" — Untyped Domain Object

**Severity: HIGH** | **Files affected: 8+** | **Effort: MEDIUM**

The core data model of the project is a `Dict[str, Any]` that represents either a cloud file, a local file, or a metadata record. Three different subsystems produce these dicts with **overlapping but different schemas**:

### 1a. Scanner produces cloud info

```python
# scanner.py:73-81
info = {
    "id": fe.get("id", ""),
    "parent_id": did,
    "name": name,
    "is_dir": fe.get("dir", False),
    "mtime": fe.get("modifyTimeForSort", 0),
    "ctime": fe.get("createTimeForSort", 0),
    "domain": fe.get("domain", 1),
}
```

### 1b. Metadata produces file info

```python
# metadata.py:377-396
result = {
    "file_id": row[0],      # ← "file_id", not "id"
    "cloud_mtime": row[1],  # ← "cloud_mtime", not "mtime"
    "local_mtime": row[2],
    # conditionally: parent_id, domain, content_hash, create_time,
    #                last_sync_at, cloud_content_hash, original_domain
}
```

### 1c. Engine converts between schemas

```python
# engine.py:416-424 — metadata → scanner format
cloud_files[path] = {
    "id": info["file_id"],           # file_id → id
    "parent_id": info.get("parent_id", ""),
    "mtime": info.get("cloud_mtime", 0),  # cloud_mtime → mtime
    "ctime": info.get("create_time", 0),   # create_time → ctime
    "domain": info.get("domain", 0),
}
```

**Problem**: Three incompatible dict schemas for "file info", with manual key translation. A typo like `info["mtme"]` silently returns `None` instead of failing. Every consumer must know which schema variant it's reading.

**Proposed fix**: Introduce 2 TypedDicts (or dataclasses):

```python
class CloudFileInfo(TypedDict):
    id: str
    parent_id: str
    name: str
    is_dir: bool
    mtime: int
    ctime: int
    domain: int

class FileMetaInfo(TypedDict):
    file_id: str
    cloud_mtime: int
    local_mtime: int
    parent_id: NotRequired[str]
    domain: NotRequired[int]
    content_hash: NotRequired[str]
    create_time: NotRequired[int]
    last_sync_at: NotRequired[int]
    cloud_content_hash: NotRequired[str]
    original_domain: NotRequired[int]
```

Then change signatures from `Dict[str, Dict]` to `Dict[str, CloudFileInfo]`.

---

## Finding 2: Untyped Stats Dict

**Severity: MEDIUM** | **Files affected: 4** | **Effort: LOW**

```python
# utils.py:176-179
def empty_stats() -> Dict:
    return {"downloaded": 0, "uploaded": 0, "skipped": 0,
            "conflicts": 0, "errors": 0, "dedup_deleted": 0}
```

Used in engine.py, git_helper.py, dedup.py. All access via string keys: `self.stats["downloaded"]`, `stats["deleted"]`, etc.

**Proposed fix**: TypedDict or dataclass:

```python
class SyncStats(TypedDict):
    downloaded: int
    uploaded: int
    skipped: int
    conflicts: int
    errors: int
    dedup_deleted: int
```

---

## Finding 3: Primitive Obsession — No NewType for IDs

**Severity: LOW** | **Files affected: all** | **Effort: LOW (gradual)**

`file_id`, `dir_id`, `parent_id`, `cloud_id` are all plain `str`. Easy to pass a `dir_id` where a `file_id` is expected, or pass a relative path where an absolute path is expected.

```python
# These are all str, but semantically different:
file_id: str      # e.g. "WEBd1234abcd"
dir_id: str       # e.g. "WEBd5678efgh"
relative_path: str  # e.g. "notes/work/todo.md"
content_hash: str   # e.g. "a1b2c3d4..."
```

**Proposed fix**:

```python
FileId = NewType("FileId", str)
DirId = NewType("DirId", str)
ContentHash = NewType("ContentHash", str)
```

Zero runtime cost. Catches wrong-ID-type bugs with mypy.

---

## Finding 4: String Literals as Enum Values

**Severity: LOW-MEDIUM** | **Files affected: 5+** | **Effort: LOW**

### 4a. search_type in search.py

```python
# search.py:127-131
if search_type == "all":
    ...
elif search_type == "folder" and is_dir:
    ...
elif search_type == "file" and not is_dir:
```

→ Should be `SearchType` enum.

### 4b. Dedup category in dedup.py / test_sync.py

```python
# test_sync.py:2411, 2423
t == "orphan"
t == "hash_mismatch"
```

→ Should be `DedupCategory` enum.

### 4c. JSON format type codes in json_convert.py

```python
F_ATTRS = "4"
F_CHILDREN = "5"
F_TYPE = "6"
# ...
attr[F_ATTR_TYPE] == "b"  # bold
attr[F_ATTR_TYPE] == "i"  # italic
```

Already uses string constants — acceptable. The `"b"` / `"i"` comparisons could use an enum, but these are dictated by the Youdao API format, so the value is marginal.

---

## Finding 5: `Any` in Protocols

**Severity: MEDIUM** | **Files affected: 1 (protocols.py) + all consumers** | **Effort: MEDIUM**

```python
class FileReader(Protocol):
    def get_file_by_id(self, file_id: str) -> Any: ...

class HttpClient(Protocol):
    def http_get(self, url: str) -> Any: ...
    def http_post(self, url: str, data: Any = ...) -> Any: ...

class SyncApi(Protocol):
    def create_async_client(self) -> Any: ...
```

`get_file_by_id` returns an httpx.Response. `http_get/http_post` also return httpx.Response. `create_async_client` returns httpx.AsyncClient.

**Proposed fix**: Replace `Any` with actual return types:

```python
def get_file_by_id(self, file_id: str) -> httpx.Response: ...
def http_get(self, url: str) -> httpx.Response: ...
def create_async_client(self) -> httpx.AsyncClient: ...
```

---

## Finding 6: Untyped Tuples

**Severity: LOW** | **Files affected: 5** | **Effort: LOW**

```python
# scanner.py:56
def _fetch_dir(did: str, bpath: str) -> tuple:  # what's in the tuple?

# metadata.py:1052
def verify(...) -> List[tuple]:  # tuple of what?

# auth.py
def extract_cookies_from_browser() -> tuple:  # ???

# dedup.py
def _cloud_score(...) -> tuple:  # (int, int, int)?
```

**Proposed fix**: Use `Tuple[X, Y]` or NamedTuple for complex returns.

---

## Finding 7: `_DownloadTask` Type Alias — Positional Tuple

**Severity: LOW** | **Files affected: 1 (pull.py)** | **Effort: LOW**

```python
_DownloadTask = Tuple[str, str, str, int, int]
```

Five positional fields with no names — easy to confuse order.

**Proposed fix**: NamedTuple or dataclass:

```python
class DownloadTask(NamedTuple):
    file_id: str
    file_name: str
    local_dir: str
    modify_time: int
    create_time: int
```

---

## Finding 8: `isinstance` on Lists — Cookie Format Ambiguity

**Severity: LOW** | **Files affected: 2 (api.py, cookies.py)** | **Effort: LOW**

```python
# api.py:106
if not isinstance(cookie, list) or len(cookie) < 4:
# cookies.py:150
cookie_names = [c[0] for c in cookies if isinstance(c, list) and len(c) >= 2]
```

Cookies are either `List[str]` (tuple format) or `Dict` (Playwright format). The code checks at runtime.

**Proposed fix**: Define a `Cookie` union type or normalize at the boundary:

```python
CookieTuple = Tuple[str, str, str, str]  # name, value, domain, path
```

---

## Finding 9: `scan_local` Returns Dict with Implicit Schema

**Severity: MEDIUM** | **Files affected: 2 (scanner.py, engine.py)** | **Effort: LOW**

```python
# scanner.py:399-460 — local file info built differently from cloud info
target[rel_path] = {
    "local_mtime": mtime,
    "local_ctime": ctime,
    "size": size,
}
# vs cloud: "mtime", "ctime", "id", "parent_id", "name", "is_dir", "domain"
```

Local and cloud info dicts have **completely different keys** but are both typed as `Dict[str, Dict]` and often passed to the same functions.

**Proposed fix**: Separate types `CloudFileInfo` and `LocalFileInfo`:

```python
class LocalFileInfo(TypedDict):
    local_mtime: int
    local_ctime: int
    size: int
```

---

## Refactoring Value Assessment

### What's already good

1. **SyncItem dataclass** — the decision layer works on a proper typed object, not raw dicts. This was a great design choice.
2. **Protocol-based DI** — 9 protocols provide clean interface segregation.
3. **Enum usage** — SyncAction, SyncDirection, FileType, FileAction cover the key domain concepts.
4. **Frozen dataclass for SyncItem** — immutability prevents accidental mutation.

### Cost-Benefit Matrix

| Refactoring | Effort | Bug-prevention value | Readability value | Risk |
|---|---|---|---|---|
| F1: CloudFileInfo + FileMetaInfo TypedDicts | 2-3 days | **HIGH** — eliminates key-typo bugs, catches schema drift | **HIGH** — self-documenting field set | MEDIUM — touches 8 files |
| F2: SyncStats TypedDict | 1 hour | LOW | MEDIUM | LOW |
| F3: NewType for IDs | 2 hours | MEDIUM (only with mypy) | LOW | LOW |
| F4: SearchType / DedupCategory enums | 1 hour | LOW-MEDIUM | MEDIUM | LOW |
| F5: Replace `Any` in protocols | 1 hour | MEDIUM | MEDIUM | LOW |
| F6: Typed tuples | 1 hour | LOW | MEDIUM | LOW |
| F7: DownloadTask NamedTuple | 30 min | LOW | MEDIUM | LOW |
| F9: LocalFileInfo TypedDict | 1 hour | MEDIUM | HIGH | LOW |

### Recommendation

**Do F1 + F2 + F9. Skip the rest for now.**

Rationale:

- **F1 (CloudFileInfo + FileMetaInfo)** is the highest-value change. The "info dict" is the project's central data model, flows through 8+ modules, has 3 incompatible schemas, and 100+ magic-key accesses. Typing it catches real bugs (key typos, schema confusion) and makes every function signature self-documenting. Estimated effort: 2-3 days.

- **F2 (SyncStats)** is a 1-hour change with clear readability benefit. No reason not to do it.

- **F9 (LocalFileInfo)** pairs naturally with F1 — once you type cloud info, typing local info is trivial and eliminates the cloud/local schema confusion.

- **F3-F8** are nice-to-haves. NewType for IDs only pays off if you enable strict mypy checking. The string-literal enums are low risk as-is. Protocol `Any` is ugly but the runtime behavior is correct.

**Full refactoring (F1-F9) would take ~4-5 days.** The targeted approach (F1+F2+F9) takes **~3 days** and captures ~80% of the type-safety value.

### Is it worth it now?

**Yes, but only the targeted subset (F1+F2+F9).** The project is in active development with ongoing sync-related changes. The info-dict pattern is the #1 source of implicit coupling between modules — every new feature that touches file metadata must mentally reconstruct the dict schema. TypedDicts provide IDE autocompletion, catch typos immediately, and serve as living documentation. The effort is modest (3 days) relative to the ongoing maintenance benefit.

The remaining items (F3-F8) can be done opportunistically when touching those files for other reasons.
