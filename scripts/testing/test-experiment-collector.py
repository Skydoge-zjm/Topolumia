"""Shared transport regressions run without provider SDKs or a server."""
from __future__ import annotations
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import subprocess
import os
import threading
import uuid
import shutil
import time
import venv
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from topolumia_collector.spool import Spool


class FakeNativeReader:
    initial_offset = 0
    def read(self, file, offset, context):
        with file.open("rb") as source:
            source.seek(offset)
            raw = source.read(4)
        if len(raw) < 4:
            return None
        context["run"] = "synthetic"
        return offset + 4, [{"kind": "scalar", "sourceRunId": "synthetic", "key": "loss", "xKey": "step", "x": struct.unpack("<I", raw)[0], "value": .5}], {}


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="topolumia-spool-test-")
        self.root = Path(self.temp.name)
        self.source = self.root / "run.wandb"
        self.source.write_bytes(struct.pack("<II", 0, 0))
        self.binding = {"provider": "wandb", "url": "http://localhost", "project": "test", "block": "one", "source": str(self.source)}
        self.spools = []

    def tearDown(self):
        for spool in self.spools:
            spool.close()
        self.temp.cleanup()

    def spool(self, **kwargs):
        spool = Spool(self.root / "queue", self.binding, **kwargs)
        spool.adapter = FakeNativeReader()
        self.spools.append(spool)
        return spool

    def test_ack_loss_replays_same_events_after_read_cursor_restart(self):
        spool = self.spool()
        spool.scan()
        batch, ids = spool.batch()
        spool.close(); self.spools.remove(spool)
        reopened = self.spool()
        self.assertEqual(reopened.batch(), (batch, ids))
        self.assertEqual(reopened.scan()["recordsRead"], 0)
        reopened.confirm(batch, ids, {"confirmedSequences": [event["seq"] for event in batch["events"]], "durableWatermark": 3, "indexedWatermark": 3})
        self.assertIsNone(reopened.batch())

    def test_partial_tail_and_append_keep_duplicate_observations(self):
        self.source.write_bytes(struct.pack("<I", 7) + b"\x07")
        spool = self.spool(); spool.scan()
        first = spool.batch()[0]
        self.assertEqual(len([event for event in first["events"] if event["kind"] == "scalar"]), 1)
        with self.source.open("ab") as out:
            out.write(b"\0\0\0")
        spool.scan()
        scalars = [event for event in spool.batch()[0]["events"] if event["kind"] == "scalar"]
        self.assertEqual([event["x"] for event in scalars], [7, 7])
        self.assertEqual(len({event["seq"] for event in scalars}), 2)

    def test_overwrite_creates_generation_and_rebind_is_rejected(self):
        spool = self.spool(); spool.scan()
        first = spool.batch()[0]["generation"]
        self.source.write_bytes(struct.pack("<I", 12))
        info = spool.scan()
        self.assertEqual(info["warnings"][0]["state"], "new-generation")
        generations = spool.db.execute("SELECT DISTINCT generation FROM queue").fetchall()
        self.assertEqual(len(generations), 2)
        self.assertIn((first,), generations)
        with self.assertRaisesRegex(ValueError, "Another collector"):
            Spool(self.root / "queue", self.binding)
        spool.close(); self.spools.remove(spool)
        with self.assertRaisesRegex(ValueError, "different connection"):
            Spool(self.root / "queue", {**self.binding, "block": "other"})

    def test_invalid_ack_retains_queue_and_quota_accounting_survives_restart(self):
        spool = self.spool(); spool.scan()
        batch, ids = spool.batch()
        with self.assertRaisesRegex(ValueError, "acknowledgement"):
            spool.confirm(batch, ids, {"confirmedSequences": []})
        self.assertIsNotNone(spool.batch())
        expected = spool.db.execute("SELECT SUM(length(body)) FROM queue").fetchone()[0] + spool.db.execute("SELECT COALESCE(SUM(size),0) FROM blobs WHERE sent=0").fetchone()[0]
        self.assertEqual(spool.usage(), expected)
        for row in spool.db.execute("SELECT hash FROM blobs WHERE sent=0").fetchall():
            spool.confirm_blob(row[0])
        spool.confirm(batch, ids, {"confirmedSequences": [event["seq"] for event in batch["events"]], "durableWatermark": 3, "indexedWatermark": 3})
        self.assertEqual(spool.usage(), 0)

    def test_process_crash_leaves_committed_queue_and_releases_ownership(self):
        script = f"""
import os,sys,struct
from pathlib import Path
sys.path.insert(0,{str(Path(__file__).resolve().parents[1] / 'runtime')!r})
from topolumia_collector.spool import Spool
class Reader:
 initial_offset=0
 def read(self,file,offset,context):
  if offset >= file.stat().st_size: return None
  return offset+4,[{{'kind':'scalar','sourceRunId':'synthetic','key':'loss','x':0,'value':.5}}],{{}}
s=Spool({str(self.root / 'queue')!r},{self.binding!r})
s.adapter=Reader()
s.scan()
os._exit(17)
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True)
        self.assertEqual(result.returncode, 17, result.stderr)
        spool = self.spool()
        self.assertGreater(len(spool.batch()[0]["events"]), 0)
        self.assertEqual(spool.scan()["recordsRead"], 0)

    def test_managed_reader_starts_reports_stops_and_resumes_with_a_new_transport_address(self):
        class Receiver(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"version":1}')
            def log_message(self, *_args):
                pass
        servers = [HTTPServer(("127.0.0.1", 0), Receiver) for _ in range(2)]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        runtime = Path(__file__).resolve().parents[1] / "runtime"
        data = self.root / "managed-data"
        reader = data / "topolumia" / "record-readers" / "wandb"
        package = reader / "package"
        shutil.copytree(runtime / "topolumia_collector", package / "topolumia_collector", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copyfile(runtime / "wandb_record_reader.py", package / "wandb_record_reader.py")
        venv.EnvBuilder(with_pip=False).create(reader / "venv")
        source = self.root / "managed-project"; source.mkdir()
        options = {"id": "record-source:" + str(uuid.uuid4()), "provider": "wandb", "directory": str(source), "dataDirectory": str(data), "projectId": "managed-test", "token": "synthetic-managed-private-token"}
        def control(action, port=servers[0].server_port):
            result = subprocess.run([sys.executable, str(runtime / "manage-record-collector.py")], input=json.dumps({**options, "action": action, "url": "http://127.0.0.1:" + str(port)}).encode(), capture_output=True, timeout=45)
            self.assertNotIn(options["token"].encode(), result.stdout + result.stderr)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return json.loads(result.stdout.decode().strip().splitlines()[-1])
        try:
            for server in servers:
                self.assertEqual(control("start", server.server_port)["status"], "starting")
                deadline = time.monotonic() + 12
                while True:
                    state = control("status")
                    if state["status"] == "running":
                        break
                    self.assertLess(time.monotonic(), deadline, state)
                    time.sleep(.2)
                self.assertEqual(state["sync"], "connected")
                self.assertEqual(control("stop")["status"], "paused")
                self.assertEqual(control("status")["status"], "stopped")
        finally:
            control("stop")
            for server, thread in zip(servers, threads):
                server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
