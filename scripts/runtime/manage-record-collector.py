"""Private JSON-stdin control for a user-owned collector. No training processes."""
from __future__ import annotations
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import venv
import zipfile
import uuid


def reader_root(data_directory=None, home=None):
    data = Path(data_directory) if data_directory else Path(home or Path.home()) / ".topolumia" / "data"
    return data / "record-readers"


def private_write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + ".tmp")
    with open(temporary, "w", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as out:
        out.write(value)
    os.replace(temporary, file)


def alive(pid):
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x1000, False, int(pid))
            if not handle:
                return False
            try:
                code = wintypes.DWORD()
                return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
            finally:
                kernel.CloseHandle(handle)
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def stop(root):
    # The private ownership file is written only after creating this child.
    try:
        process = json.loads((root / "process.json").read_text())
    except (OSError, ValueError):
        return
    pid = process.get("pid")
    try:
        state = json.loads((root / "state.json").read_text())
        if state.get("instance") == process["instance"]:
            pid = state.get("pid", pid)
    except (OSError, ValueError):
        pass
    if alive(pid):
        # A private instance request cannot signal a training process or reused PID.
        private_write(root / "control.json", json.dumps({"stop": process["instance"]}))
        deadline = time.monotonic() + 35
        while alive(pid) and time.monotonic() < deadline:
            try:
                state = json.loads((root / "state.json").read_text())
                if os.name != "nt" and state.get("instance") == process["instance"] and state.get("status") == "stopped":
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        else:
            if alive(pid):
                raise ValueError("Collector has not stopped yet; retry after its upload finishes")
    (root / "process.json").unlink(missing_ok=True)


def main():
    options = json.load(sys.stdin)
    if sys.version_info < (3, 10):
        raise ValueError("Python 3.10+ is required for the record adapter")
    if options.get("provider") not in ("wandb", "tensorboard"):
        raise ValueError("Unsupported record adapter")
    source_id = options["id"]
    if not isinstance(source_id, str) or not source_id.startswith("record-source:") or len(source_id) != 50:
        raise ValueError("Invalid project source identity")
    base = reader_root(options.get("dataDirectory"))
    root = base / "sources" / hashlib.sha256(source_id.encode()).hexdigest()[:32]
    root.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        root.chmod(0o700)
    action = options["action"]
    if action in ("stop", "start", "deploy"):
        stop(root)
    if action == "stop":
        print(json.dumps({"status": "paused"}))
        return
    if action == "status":
        try:
            process = json.loads((root / "process.json").read_text())
            state = json.loads((root / "state.json").read_text())
            active = state.get("instance") == process.get("instance") and alive(state.get("pid")) and state.get("status") != "stopped" and time.time() - state.get("checkedAt", 0) < 90
            print(json.dumps({**state, "status": "running" if active else "error" if state.get("status") == "error" and state.get("instance") == process.get("instance") else "stopped", "root": str(root)}))
        except (OSError, ValueError):
            print(json.dumps({"status": "stopped", "root": str(root)}))
        return
    reader = base / options["provider"]
    package = reader / "package"
    environment = reader / "venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if action == "deploy":
        reader.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(options["package"]))) as archive:
            for name in archive.namelist():
                target = (package / name).resolve()
                if not target.is_relative_to(package.resolve()):
                    raise ValueError("Invalid collector source package")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
        if not (environment / "pyvenv.cfg").exists():
            print("TOPOLUMIA_PHASE:preparing", flush=True)
            venv.EnvBuilder(with_pip=True).create(environment)
        marker = reader / "installed.json"
        if not marker.exists():
            print("TOPOLUMIA_PHASE:installing", flush=True)
            dependency = "wandb>=0.19,<0.32" if options["provider"] == "wandb" else "tensorboard>=2.19,<2.22"
            installed = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--timeout", "20", "--retries", "1", dependency], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if installed.returncode:
                raise ValueError("读取器依赖安装失败，请检查训练主机的包下载源或网络后重新部署。")
            private_write(marker, json.dumps({"dependency": dependency}))
    if not python.is_file() or not (package / "topolumia_collector" / "cli.py").is_file():
        raise ValueError("Adapter is not deployed; deploy and enable it again")
    source = Path(options["directory"]).expanduser().resolve()
    if not source.is_dir():
        raise ValueError("Project record directory does not exist: " + str(source))
    private_write(root / "token", options["token"])
    private_write(root / "connection.json", json.dumps({"url": options["url"], "project": options["projectId"], "tokenFile": str(root / "token"), "connectionId": source_id}))
    instance = uuid.uuid4().hex
    command = [str(python), "-u", "-m", "topolumia_collector.cli", "watch", "--connection", str(root / "connection.json"), "--provider", options["provider"], "--source", str(source), "--block", source_id, "--spool", str(root / "spool"), "--state-file", str(root / "state.json"), "--instance", instance]
    flags = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "PYTHONPATH": str(package)}, **flags)
    private_write(root / "process.json", json.dumps({"pid": child.pid, "instance": instance, "startedAt": time.time()}))
    print(json.dumps({"status": "starting", "root": str(root), "pid": child.pid}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)[:500]}))
        sys.exit(1)
