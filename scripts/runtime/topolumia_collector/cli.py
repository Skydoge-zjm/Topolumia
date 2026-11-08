from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import http.client
import json
import os
import signal
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, quote
from urllib.request import Request, urlopen
from .spool import Spool, dumps


class Sender:
    def __init__(self, connection, block):
        self.connection = connection
        self.base = connection["url"].rstrip("/") + "/api/record-ingestion/" + quote(block, safe="")

    def headers(self):
        token = Path(self.connection["tokenFile"]).read_text().strip()
        return {"Authorization": "Bearer " + token, "x-rw-project-id": self.connection["project"]}

    def capabilities(self):
        with urlopen(Request(self.base + "/capabilities", headers=self.headers()), timeout=20) as response:
            result = json.load(response)
        if result.get("version") != 1:
            raise RuntimeError("Receiver requires a different collector protocol")
        return result

    def batch(self, batch):
        request = Request(self.base + "/batches", data=gzip.compress(dumps(batch).encode()), headers={**self.headers(), "Content-Type": "application/json", "Content-Encoding": "gzip"}, method="POST")
        with urlopen(request, timeout=20) as response:
            return json.load(response)

    def blob(self, checksum, file, size):
        url = urlparse(self.base + "/attachments/" + checksum)
        connection = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(url.hostname, url.port, timeout=30)
        try:
            with file.open("rb") as data:
                connection.request("PUT", url.path, body=data, headers={**self.headers(), "Content-Type": "application/octet-stream", "Content-Length": str(size)})
                response = connection.getresponse()
                if response.status != 200:
                    raise RuntimeError("Attachment HTTP " + str(response.status))
                return json.loads(response.read(8192))
        finally:
            connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(prog="topolumia-collector")
    sub = parser.add_subparsers(dest="command", required=True)
    connect = sub.add_parser("connect")
    for name in ("url", "project", "token-file", "connection"):
        connect.add_argument("--" + name, required=True)
    watch = sub.add_parser("watch")
    for name in ("connection", "block", "source", "spool"):
        watch.add_argument("--" + name, required=True)
    watch.add_argument("--provider", choices=("wandb", "tensorboard"), required=True)
    watch.add_argument("--once", action="store_true")
    watch.add_argument("--interval", type=float, default=2)
    watch.add_argument("--max-queue-mib", type=int, default=128)
    watch.add_argument("--state-file")
    watch.add_argument("--instance")
    status = sub.add_parser("status"); status.add_argument("--spool", required=True)
    args = parser.parse_args(argv)
    if args.command == "connect":
        url = urlparse(args.url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            parser.error("Use an HTTP(S) workbench address without embedded credentials")
        if url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"):
            parser.error("Use HTTPS for a remote server or an SSH tunnel to localhost")
        token = Path(args.token_file).resolve()
        if not token.is_file():
            parser.error("Create the token file with the credential from the record block")
        if os.name != "nt":
            token.chmod(0o600)
        target = Path(args.connection).resolve(); target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(dumps({"url": args.url.rstrip("/"), "project": args.project, "tokenFile": str(token)}))
        if os.name != "nt":
            target.chmod(0o600)
        print(dumps({"connected": True, "connection": str(target)})); return
    if args.command == "status":
        import sqlite3
        file = Path(args.spool).resolve() / "queue.sqlite"
        with sqlite3.connect(file.as_uri() + "?mode=ro", uri=True) as db:
            print(dumps({"pendingEvents": db.execute("SELECT count(*) FROM queue").fetchone()[0], "pendingAttachments": db.execute("SELECT count(*) FROM blobs WHERE sent=0").fetchone()[0], "confirmed": db.execute("SELECT stream,writer,generation,seq FROM confirmed").fetchall()}))
        return
    if args.interval < .1 or not 1 <= args.max_queue_mib <= 65536:
        parser.error("interval >= 0.1, queue quota 1..65536 MiB")
    connection = json.loads(Path(args.connection).read_text())
    source = Path(args.source).resolve()
    if not source.exists():
        parser.error("Source must exist")
    binding = {**({"connectionId": connection["connectionId"]} if connection.get("connectionId") else {"url": connection["url"]}), "project": connection["project"], "block": args.block, "provider": args.provider, "source": str(source)}
    spool = Spool(args.spool, binding, args.max_queue_mib * 1024 * 1024)
    sender = Sender(connection, args.block)
    stopped, failures, negotiated = False, 0, False
    uploads = ThreadPoolExecutor(max_workers=1, thread_name_prefix="topolumia-attachments")
    upload = None
    upload_checksum, upload_size = None, None
    def report(info):
        if args.state_file:
            state = Path(args.state_file)
            temporary = state.with_suffix(".tmp")
            temporary.write_text(dumps({**info, "checkedAt": time.time(), "pid": os.getpid(), "instance": args.instance}))
            os.replace(temporary, state)
    def stop_requested():
        if not args.instance or not args.state_file:
            return False
        try:
            return json.loads(Path(args.state_file).with_name("control.json").read_text()).get("stop") == args.instance
        except (OSError, ValueError):
            return False
    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    try:
        while not stopped:
            if stop_requested():
                break
            info = spool.scan()
            try:
                if not negotiated:
                    sender.capabilities(); negotiated = True
                if upload and upload.done():
                    result = upload.result()
                    if result.get("sha256") != upload_checksum or result.get("size") != upload_size:
                        raise ValueError("Invalid attachment acknowledgement")
                    spool.confirm_blob(upload_checksum)
                    upload = None
                for _ in range(10):
                    pending = spool.batch()
                    if not pending:
                        break
                    batch, ids = pending
                    spool.confirm(batch, ids, sender.batch(batch))
                blob = spool.next_blob() if upload is None else None
                if blob:
                    upload_checksum, file, upload_size = blob
                    upload = uploads.submit(sender.blob, upload_checksum, file, upload_size)
                failures = 0
                state = {**info, "sync": "connected", "queueBytes": spool.usage(), "attachments": "uploading" if upload else "idle"}
                report(state)
                print(dumps(state), flush=True)
                if args.once and not info["backpressure"] and info["recordsRead"] == 0 and upload is None and not spool.batch() and not spool.next_blob():
                    break
            except (OSError, ValueError, RuntimeError) as error:
                failures += 1
                if upload and upload.done():
                    upload = None
                state = {"sync": "waiting", "error": str(error), "queueBytes": spool.usage(), "retry": failures}
                report(state)
                print(dumps(state), file=sys.stderr, flush=True)
                if args.once:
                    raise SystemExit(2) from error
            if args.once and failures == 0:
                if upload and not spool.batch():
                    time.sleep(.1)
                continue
            deadline = time.monotonic() + min(30, args.interval * (2 ** min(failures, 4)))
            while not stopped and not stop_requested() and time.monotonic() < deadline:
                time.sleep(min(.2, max(0, deadline - time.monotonic())))
    finally:
        uploads.shutdown(wait=True, cancel_futures=True)
        remaining = spool.usage()
        spool.close()
        report({"sync": "stopped", "status": "stopped", "queueBytes": remaining})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if "--state-file" in sys.argv:
            state = Path(sys.argv[sys.argv.index("--state-file") + 1])
            instance = sys.argv[sys.argv.index("--instance") + 1] if "--instance" in sys.argv else None
            temporary = state.with_suffix(".tmp")
            temporary.write_text(dumps({"status": "error", "sync": "error", "error": str(error)[:500], "pid": os.getpid(), "instance": instance, "checkedAt": time.time()}))
            os.replace(temporary, state)
        print(dumps({"status": "error", "error": str(error)[:500]}), file=sys.stderr)
        raise SystemExit(2) from error
