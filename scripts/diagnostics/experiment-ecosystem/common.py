"""Shared helpers for isolated, synthetic experiment-ecosystem research."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
import time
import traceback
from pathlib import Path


def safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return {"nonfinite": str(value)}
    if isinstance(value, dict):
        return {str(key): safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "item"):
        return safe(value.item())
    return value


def write_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(safe(value), ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    temporary.replace(file)


class Probe:
    def __init__(self, root, product):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.product = product
        self.results = []

    def case(self, name, action, *, expected_error=False):
        started = time.perf_counter()
        try:
            value = action()
            result = {"case": name, "status": "api_completed", "value": value}
        except Exception as error:
            result = {"case": name, "status": "observed_rejection" if expected_error else "error",
                      "errorType": type(error).__name__, "error": str(error),
                      "traceback": traceback.format_exc()[-5000:]}
        result["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
        self.results.append(result)
        self.save()
        return result

    def save(self):
        write_json(self.root / "api-results.json", {"product": self.product, "cases": self.results})


def versions():
    names = ["wandb", "tensorboard", "tensorboardX", "mlflow-skinny", "numpy", "pandas", "pillow",
             "matplotlib", "plotly", "protobuf", "moviepy", "imageio-ffmpeg", "soundfile"]
    result = {}
    for name in names:
        try:
            result[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            result[name] = None
    return result


def inventory(root, output):
    root = Path(root).resolve()
    files = []
    for file in sorted(root.rglob("*")):
        if not file.is_file() or file == Path(output).resolve():
            continue
        digest = hashlib.sha256()
        try:
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            files.append({"path": file.relative_to(root).as_posix(), "bytes": file.stat().st_size,
                          "sha256": digest.hexdigest()})
        except OSError as error:
            files.append({"path": file.relative_to(root).as_posix(), "error": str(error)})
    write_json(output, {"files": files, "count": len(files), "bytes": sum(f.get("bytes", 0) for f in files)})


def isolated_env(root):
    # Never load a user's W&B account/project configuration or upload to a cloud service.
    env = {key: value for key, value in os.environ.items() if not key.startswith(("WANDB_", "MLFLOW_"))}
    local = Path(root).resolve()
    env.update({"WANDB_MODE": "offline", "WANDB_SILENT": "true", "WANDB_CONSOLE": "off",
                "WANDB_CONFIG_DIR": str(local / "wandb-config"), "WANDB_CACHE_DIR": str(local / "wandb-cache"),
                "WANDB_DATA_DIR": str(local / "wandb-data"), "WANDB_DISABLE_GIT": "true",
                "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "MPLBACKEND": "Agg",
                "DO_NOT_TRACK": "true", "MLFLOW_ENABLE_TELEMETRY": "false", "MLFLOW_DISABLE_AGENT_HINT": "1"})
    return env
