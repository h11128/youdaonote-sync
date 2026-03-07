"""Fixed-block hashing for block-level file change detection and delta encoding."""

import struct
from dataclasses import dataclass
from typing import List, Tuple

import xxhash


@dataclass
class ChangedBlock:
    offset: int
    length: int
    block_type: str


class BlockHash:
    """Fixed-size block hasher using xxhash for change detection."""

    def __init__(self, block_size: int = 4096):
        if block_size < 1:
            raise ValueError(f"block_size must be positive, got {block_size}")
        self.block_size = block_size

    def compute_block_hashes(self, file_path: str) -> List[Tuple[int, int, str]]:
        result = []
        with open(file_path, "rb") as f:
            offset = 0
            while True:
                chunk = f.read(self.block_size)
                if not chunk:
                    break
                h = xxhash.xxh64(chunk).hexdigest()
                result.append((offset, len(chunk), h))
                offset += len(chunk)
        return result


def diff_blocks(
    old_hashes: List[Tuple[int, int, str]], new_hashes: List[Tuple[int, int, str]]
) -> List[dict]:
    result = []
    n_old, n_new = len(old_hashes), len(new_hashes)
    for i in range(max(n_old, n_new)):
        if i >= n_old:
            o, length, _ = new_hashes[i]
            result.append({"offset": o, "length": length, "block_type": "added"})
        elif i >= n_new:
            o, length, _ = old_hashes[i]
            result.append({"offset": o, "length": length, "block_type": "removed"})
        else:
            old_o, old_len, old_h = old_hashes[i]
            new_o, new_len, new_h = new_hashes[i]
            if old_h != new_h:
                result.append({"offset": new_o, "length": new_len, "block_type": "changed"})
    return result


def encode_delta(old_path: str, new_path: str) -> bytes:
    rh = BlockHash()
    old_hashes = rh.compute_block_hashes(old_path)
    new_hashes = rh.compute_block_hashes(new_path)
    delta = bytearray()
    with open(old_path, "rb") as old_f, open(new_path, "rb") as new_f:
        old_data, new_data = old_f.read(), new_f.read()
    n_old, n_new = len(old_hashes), len(new_hashes)
    for i in range(n_new):
        new_o, new_len, new_h = new_hashes[i]
        new_block = new_data[new_o : new_o + new_len]
        if i < n_old and old_hashes[i][2] == new_h:
            old_o = old_hashes[i][0]
            delta.extend(struct.pack("<BII", 0, old_o, new_len))
        else:
            delta.extend(struct.pack("<BI", 1, new_len))
            delta.extend(new_block)
    return bytes(delta)


def apply_delta(old_path: str, delta: bytes) -> bytes:
    with open(old_path, "rb") as f:
        old_data = f.read()
    result = bytearray()
    pos = 0
    while pos < len(delta):
        op = delta[pos]
        pos += 1
        if op == 0:
            if pos + 8 > len(delta):
                raise ValueError(f"Delta truncated at COPY op (pos={pos}, need 8 bytes)")
            offset, length = struct.unpack("<II", delta[pos : pos + 8])
            pos += 8
            if offset + length > len(old_data):
                raise ValueError(
                    f"COPY out of range: offset={offset} length={length} old_size={len(old_data)}"
                )
            result.extend(old_data[offset : offset + length])
        elif op == 1:
            if pos + 4 > len(delta):
                raise ValueError(f"Delta truncated at INSERT op (pos={pos}, need 4 bytes)")
            (length,) = struct.unpack("<I", delta[pos : pos + 4])
            pos += 4
            if pos + length > len(delta):
                raise ValueError(
                    f"INSERT out of range: pos={pos} length={length} delta_size={len(delta)}"
                )
            result.extend(delta[pos : pos + length])
            pos += length
        else:
            raise ValueError(f"Unknown delta op: {op} at pos={pos - 1}")
    return bytes(result)
