"""Durable local read cursor and independently acknowledged outbound queue."""
from __future__ import annotations
import json
import importlib.metadata
import os
import re
import sqlite3
import uuid
import time
from pathlib import Path
from .adapters import ADAPTERS, digest, file_digest


def dumps(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


class Spool:
    def __init__(self, directory, binding, max_bytes=128 * 1024 * 1024):
        self.root = Path(directory).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            self.root.chmod(0o700)
        self.lock = (self.root / ".collector.lock").open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(self.lock.fileno()).st_size == 0:
                    self.lock.write(b"0"); self.lock.flush()
                self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.lock.close()
            raise ValueError("Another collector owns this spool") from error
        self.closed = False
        self.db = sqlite3.connect(self.root / "queue.sqlite")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
          CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,body TEXT);
          CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY,stream TEXT,writer TEXT,generation TEXT,seq INTEGER,body TEXT,UNIQUE(stream,writer,generation,seq));
          CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY,size INTEGER,sent INTEGER);
          CREATE TABLE IF NOT EXISTS confirmed(stream TEXT,writer TEXT,generation TEXT,seq INTEGER,PRIMARY KEY(stream,writer,generation));
        """)
        old = self.db.execute("SELECT value FROM settings WHERE key='binding'").fetchone()
        if old and json.loads(old[0]) != binding:
            self.db.close()
            self.lock.close()
            raise ValueError("Spool is bound to a different connection / record block / source")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO settings VALUES('binding',?)", (dumps(binding),))
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY,value INTEGER);
          INSERT OR IGNORE INTO counters SELECT 'pending',(SELECT COALESCE(SUM(length(body)),0) FROM queue)+(SELECT COALESCE(SUM(size),0) FROM blobs WHERE sent=0);
          CREATE TRIGGER IF NOT EXISTS queue_added AFTER INSERT ON queue BEGIN UPDATE counters SET value=value+length(NEW.body) WHERE key='pending'; END;
          CREATE TRIGGER IF NOT EXISTS queue_removed AFTER DELETE ON queue BEGIN UPDATE counters SET value=value-length(OLD.body) WHERE key='pending'; END;
          CREATE TRIGGER IF NOT EXISTS blob_added AFTER INSERT ON blobs WHEN NEW.sent=0 BEGIN UPDATE counters SET value=value+NEW.size WHERE key='pending'; END;
          CREATE TRIGGER IF NOT EXISTS blob_sent AFTER UPDATE OF sent ON blobs WHEN OLD.sent=0 AND NEW.sent=1 BEGIN UPDATE counters SET value=value-OLD.size WHERE key='pending'; END;
        """)
        for child in self.root.iterdir():
            if re.fullmatch(r"[a-f0-9]{64}(?:\.tmp)?", child.name) and child.is_file():
                known = self.db.execute("SELECT sent FROM blobs WHERE hash=?", (child.name[:64],)).fetchone()
                if child.name.endswith(".tmp") or not known or known[0]:
                    child.unlink()
        self.binding, self.max_bytes = binding, max_bytes
        self.adapter = ADAPTERS[binding["provider"]]()
        try:
            sdk_version = importlib.metadata.version(binding["provider"])
        except importlib.metadata.PackageNotFoundError:
            sdk_version = "not-installed"
        self.source_info = {"adapterVersion": "0.1.0", "sdkVersion": sdk_version, "cursorEncoding": "native-byte-offset.v1"}

    def usage(self):
        return self.db.execute("SELECT value FROM counters WHERE key='pending'").fetchone()[0]

    def store_blob(self, checksum, value):
        if self.db.execute("SELECT 1 FROM blobs WHERE hash=? AND sent=1", (checksum,)).fetchone():
            return
        file = self.root / checksum
        if not file.exists():
            temporary = self.root / (checksum + ".tmp")
            with temporary.open("wb") as out:
                if isinstance(value, Path):
                    with value.open("rb") as source:
                        while data := source.read(65536):
                            out.write(data)
                else:
                    out.write(value)
                out.flush(); os.fsync(out.fileno())
            if file_digest(temporary, None) != checksum:
                temporary.unlink()
                raise ValueError("Source attachment changed while copying")
            os.replace(temporary, file)
        self.db.execute("INSERT OR IGNORE INTO blobs VALUES(?,?,0)", (checksum, file.stat().st_size))

    @staticmethod
    def anchor(file, offset):
        with file.open("rb") as source:
            source.seek(max(0, offset - 64))
            return digest(source.read(min(64, offset)))

    def discover(self):
        root = Path(self.binding["source"])
        if root.is_file():
            return [root] if not root.is_symlink() else []
        now = time.monotonic()
        if now >= getattr(self, "discovery_at", 0):
            files = []
            excluded = {".git", ".venv", "venv", "node_modules", "__pycache__", ".cache", ".topolumia", ".topolumia-transfer", "runtime"}
            for directory, children, names in os.walk(root, followlinks=False):
                children[:] = sorted(name for name in children if name not in excluded and not (Path(directory) / name).is_symlink())
                for name in sorted(names):
                    if name.endswith(".wandb") if self.binding["provider"] == "wandb" else "tfevents" in name:
                        file = Path(directory) / name
                        if file.is_file() and not file.is_symlink():
                            files.append(file)
            self.discovered = files
            self.discovery_at = now + (5 if self.binding.get("connectionId") else 0)
        return [file for file in self.discovered if file.is_file()]

    def scan(self, max_records=500):
        records, warnings, blocked = 0, [], False
        source = Path(self.binding["source"]).resolve()
        for file in self.discover():
            if self.usage() >= self.max_bytes or records >= max_records:
                break
            name = str(file.resolve())
            old = self.db.execute("SELECT body FROM files WHERE path=?", (name,)).fetchone()
            state = json.loads(old[0]) if old else None
            info = file.stat()
            inode = [info.st_dev, info.st_ino]
            if state and (state["inode"] != inode or info.st_size < state["offset"] or state["anchor"] != self.anchor(file, state["offset"]) or state.get("prefix", self.anchor(file, min(64, state["offset"]))) != self.anchor(file, min(64, state["offset"]))):
                warnings.append({"file": file.name, "state": "new-generation"})
                state = None
            if state is None:
                offset = self.adapter.initial_offset
                if info.st_size < offset:
                    continue
                relative = file.relative_to(source) if source.is_dir() else Path(file.name)
                stream = str(relative.parent) if self.binding["provider"] == "tensorboard" else str(relative)
                state = {"inode": inode, "generation": uuid.uuid4().hex, "offset": offset, "seq": 0, "context": {}, "stream": stream, "writer": str(relative), "anchor": self.anchor(file, offset)}
                if self.binding["provider"] == "tensorboard":
                    state["context"]["run"] = str(relative.parent) if str(relative.parent) != "." else file.parent.name
            while records < max_records and self.usage() < self.max_bytes:
                context = json.loads(dumps(state["context"]))
                result = self.adapter.read(file, state["offset"], context)
                if result is None:
                    break
                end, events, attachments = result
                normalized = []
                for event in events:
                    if len(dumps(event).encode()) > 1024 * 1024:
                        raw = dumps(event).encode(); checksum = digest(raw); attachments[checksum] = raw
                        event = {"kind": "extension", "sourceRunId": event["sourceRunId"], "key": event.get("key", "oversized-record"), "data": {"reason": "oversized-normalized-record", "attachments": [{"sha256": checksum, "name": "record.json"}]}}
                    normalized.append(event)
                for index, event in enumerate(normalized):
                    event["seq"] = state["seq"] + index
                extra = sum(len(dumps(event)) for event in normalized) + sum(value.stat().st_size if isinstance(value, Path) else len(value) for checksum, value in attachments.items() if not self.db.execute("SELECT 1 FROM blobs WHERE hash=?", (checksum,)).fetchone())
                if extra > self.max_bytes:
                    raise ValueError("One native record exceeds the configured queue quota; increase --max-queue-mib")
                if self.usage() + extra > self.max_bytes:
                    blocked = True
                    break
                with self.db:
                    for checksum, value in attachments.items():
                        self.store_blob(checksum, value)
                    for event in normalized:
                        event["seq"] = state["seq"]
                        self.db.execute("INSERT INTO queue(stream,writer,generation,seq,body) VALUES(?,?,?,?,?)", (state["stream"], state["writer"], state["generation"], state["seq"], dumps(event)))
                        state["seq"] += 1
                    state.update(offset=end, context=context, anchor=self.anchor(file, end), prefix=self.anchor(file, min(64, end)))
                    self.db.execute("INSERT OR REPLACE INTO files VALUES(?,?)", (name, dumps(state)))
                records += 1
            # Archive completed native byte ranges independently of curve records.
            archived = state.get("archivedOffset", 0)
            if state["offset"] > archived and self.max_bytes - self.usage() > 2048:
                with file.open("rb") as native:
                    native.seek(archived)
                    data = native.read(min(4 * 1024 * 1024, state["offset"] - archived, self.max_bytes - self.usage() - 2048))
                checksum = digest(data)
                event = {"seq": state["seq"], "sourceRunId": state["context"].get("run", file.stem.removeprefix("run-")), "kind": "file", "key": "native/source", "data": {"path": state["writer"], "offset": archived, "end": archived + len(data), "generation": state["generation"], "attachments": [{"sha256": checksum, "name": file.name}]}}
                with self.db:
                    self.store_blob(checksum, data)
                    self.db.execute("INSERT INTO queue(stream,writer,generation,seq,body) VALUES(?,?,?,?,?)", (state["stream"], state["writer"], state["generation"], state["seq"], dumps(event)))
                    state["seq"] += 1
                    state["archivedOffset"] = archived + len(data)
                    self.db.execute("INSERT OR REPLACE INTO files VALUES(?,?)", (name, dumps(state)))
                records += 1
            elif state["offset"] > archived:
                blocked = True
        if source.is_dir() and hasattr(self.adapter, "sidecars") and time.monotonic() >= getattr(self, "sidecars_at", 0):
            self.sidecars_at = time.monotonic() + (10 if self.binding.get("connectionId") else 0)
            for name, stream, event, attachments in self.adapter.sidecars(source):
                fingerprint = digest(dumps(event).encode())
                key = "sidecar:" + name
                old = self.db.execute("SELECT body FROM files WHERE path=?", (key,)).fetchone()
                state = json.loads(old[0]) if old else {"fingerprint": None, "seq": 0}
                if state["fingerprint"] == fingerprint:
                    continue
                event["seq"] = state["seq"]
                extra = len(dumps(event)) + sum(value.stat().st_size if isinstance(value, Path) else len(value) for checksum, value in attachments.items() if not self.db.execute("SELECT 1 FROM blobs WHERE hash=?", (checksum,)).fetchone())
                if self.usage() + extra > self.max_bytes:
                    blocked = True
                    break
                with self.db:
                    for checksum, value in attachments.items():
                        self.store_blob(checksum, value)
                    self.db.execute("INSERT INTO queue(stream,writer,generation,seq,body) VALUES(?,?,?,?,?)", (stream, name, "sidecars.v1", state["seq"], dumps(event)))
                    self.db.execute("INSERT OR REPLACE INTO files VALUES(?,?)", (key, dumps({"fingerprint": fingerprint, "seq": state["seq"] + 1})))
                records += 1
        return {"recordsRead": records, "queueBytes": self.usage(), "backpressure": blocked or self.usage() >= self.max_bytes, "warnings": warnings}

    def batch(self):
        first = self.db.execute("SELECT stream,writer,generation FROM queue ORDER BY id LIMIT 1").fetchone()
        if not first:
            return None
        rows = self.db.execute("SELECT id,body FROM queue WHERE stream=? AND writer=? AND generation=? ORDER BY seq LIMIT 128", first).fetchall()
        kept, size = [], 0
        for row in rows:
            size += len(row[1].encode())
            if size > 1_800_000:
                break
            kept.append(row)
        if not kept:
            raise ValueError("Queued event exceeds batch size")
        return {"version": 1, "sourceInfo": self.source_info, "provider": self.binding["provider"], "streamId": first[0], "writerId": first[1], "generation": first[2], "events": [json.loads(row[1]) for row in kept]}, [row[0] for row in kept]

    def confirm(self, batch, ids, ack):
        expected = [event["seq"] for event in batch["events"]]
        if ack.get("confirmedSequences") != expected or not isinstance(ack.get("durableWatermark"), int) or not isinstance(ack.get("indexedWatermark"), int) or ack["indexedWatermark"] < 0 or ack["indexedWatermark"] > ack["durableWatermark"]:
            raise ValueError("Invalid server acknowledgement; queue retained")
        with self.db:
            self.db.executemany("DELETE FROM queue WHERE id=?", [(id,) for id in ids])
            self.db.execute("INSERT OR REPLACE INTO confirmed VALUES(?,?,?,?)", (batch["streamId"], batch["writerId"], batch["generation"], max(expected)))

    def next_blob(self):
        row = self.db.execute("SELECT hash,size FROM blobs WHERE sent=0 LIMIT 1").fetchone()
        return (row[0], self.root / row[0], row[1]) if row else None

    def confirm_blob(self, checksum):
        with self.db:
            self.db.execute("UPDATE blobs SET sent=1 WHERE hash=?", (checksum,))
        (self.root / checksum).unlink(missing_ok=True)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.close()
        self.lock.close()
