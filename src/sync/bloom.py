"""
Bloom filter for probabilistic set membership.

Used in youdao note sync for efficient "seen" tracking (e.g. deduplication).
False positives possible; false negatives are not.
"""

import math
import struct
from typing import List

import xxhash


def _optimal_m(n: int, p: float) -> int:
    """m = -n * ln(p) / (ln(2)^2)"""
    return max(1, int(-n * math.log(p) / (math.log(2) ** 2)))


def _optimal_k(m: int, n: int) -> int:
    """k = m/n * ln(2)"""
    return max(1, int(m * math.log(2) / n))


class BloomFilter:
    """
    Space-efficient probabilistic set for membership testing.

    Uses xxhash with different seeds for k independent hash functions.
    Serialization format: 8-byte header (m, k as uint32) + raw bit array.
    """

    def __init__(self, expected_items: int, fp_rate: float = 0.01) -> None:
        if not (0 < fp_rate < 1):
            raise ValueError(f"fp_rate must be in (0, 1), got {fp_rate}")
        n = max(1, expected_items)
        self._m = _optimal_m(n, fp_rate)
        self._k = min(_optimal_k(self._m, n), self._m)
        self._bits = bytearray((self._m + 7) // 8)

    def _hashes(self, item: str) -> List[int]:
        """Kirsch-Mitzenmacher: h_i = h1 + i*h2 mod m for better independence."""
        data = item.encode("utf-8")
        h1 = xxhash.xxh64(data, seed=0).intdigest()
        h2 = xxhash.xxh64(data, seed=0x9E3779B97F4A7C15).intdigest()
        return [(h1 + i * h2) % self._m for i in range(self._k)]

    def add(self, item: str) -> None:
        """Add item to the filter."""
        for pos in self._hashes(item):
            self._bits[pos // 8] |= 1 << (pos % 8)

    def might_contain(self, item: str) -> bool:
        """Return True if item may be in the set (may have false positives)."""
        for pos in self._hashes(item):
            if not (self._bits[pos // 8] & (1 << (pos % 8))):
                return False
        return True

    def serialize(self) -> bytes:
        """Serialize to bytes for storage or transmission."""
        return struct.pack("<II", self._m, self._k) + bytes(self._bits)

    @classmethod
    def deserialize(cls, data: bytes) -> "BloomFilter":
        """Reconstruct from serialized bytes."""
        if len(data) < 8:
            raise ValueError(f"Bloom filter data too short: {len(data)} bytes (need ≥8)")
        m, k = struct.unpack("<II", data[:8])
        if m < 1 or k < 1:
            raise ValueError(f"Invalid Bloom filter parameters: m={m}, k={k} (both must be ≥1)")
        expected_bytes = (m + 7) // 8
        actual_bytes = len(data) - 8
        if actual_bytes != expected_bytes:
            raise ValueError(
                f"Bloom filter bit array size mismatch: got {actual_bytes}, expected {expected_bytes}"
            )
        bf = object.__new__(cls)
        bf._m = m
        bf._k = k
        bf._bits = bytearray(data[8:])
        return bf
