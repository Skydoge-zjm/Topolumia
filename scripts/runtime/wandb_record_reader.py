"""Read-only adapter for the W&B LevelDB log container.

Derived from the official W&B datastore reader (v0.19.11):
https://github.com/wandb/wandb/blob/v0.19.11/wandb/sdk/internal/datastore.py
The current SDK still supplies the protobuf definitions; no logging API is added.

MIT License
Copyright (c) 2021 Weights and Biases, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from __future__ import annotations
import struct
import zlib

BLOCK_SIZE = 32768
HEADER_SIZE = 7


class WandbRecordReader:
    def __init__(self, file):
        self.file = open(file, "rb")
        header = self.file.read(HEADER_SIZE)
        if len(header) != HEADER_SIZE or struct.unpack("<4sHB", header) != (b":W&B", 0xBEE1, 0):
            self.file.close()
            raise ValueError("Invalid W&B record container header")
        self.crc = {kind: zlib.crc32(bytes([kind])) & 0xFFFFFFFF for kind in range(1, 5)}

    def fragment(self):
        remaining = BLOCK_SIZE - self.file.tell() % BLOCK_SIZE
        if remaining < HEADER_SIZE:
            padding = self.file.read(remaining)
            if not padding:
                return None
            if len(padding) != remaining:
                raise ValueError("Incomplete W&B record padding")
            if padding != b"\0" * remaining:
                raise ValueError("Invalid W&B record padding")
        available = BLOCK_SIZE - self.file.tell() % BLOCK_SIZE
        header = self.file.read(HEADER_SIZE)
        if not header:
            return None
        if len(header) != HEADER_SIZE:
            raise ValueError("Incomplete W&B record header")
        checksum, length, kind = struct.unpack("<IHB", header)
        if kind not in self.crc or length > available - HEADER_SIZE:
            raise ValueError("Invalid W&B record fragment")
        data = self.file.read(length)
        if len(data) != length:
            raise ValueError("Incomplete W&B record data")
        if checksum != zlib.crc32(data, self.crc[kind]) & 0xFFFFFFFF:
            raise ValueError("Invalid W&B record checksum")
        return kind, data

    def scan_data(self):
        fragment = self.fragment()
        if fragment is None:
            return None
        kind, data = fragment
        if kind == 1:
            return data
        if kind != 2:
            raise ValueError("Expected the first W&B record fragment")
        parts = [data]
        total = len(data)
        while True:
            fragment = self.fragment()
            if fragment is None:
                raise ValueError("Incomplete fragmented W&B record")
            kind, data = fragment
            if kind not in (3, 4):
                raise ValueError("Invalid fragmented W&B record sequence")
            total += len(data)
            if total > 64 * 1024 * 1024:
                raise ValueError("W&B record exceeds 64 MiB reader limit")
            parts.append(data)
            if kind == 4:
                return b"".join(parts)

    def close(self):
        self.file.close()
