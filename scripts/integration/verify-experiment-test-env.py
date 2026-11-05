#!/usr/bin/env python3
"""Probe the isolated experiment-tracking Python environment.

The full integration mode also writes real TensorBoard, MLflow and W&B
offline records into a caller-provided temporary directory.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import sys
import time
from io import BytesIO
from pathlib import Path


PACKAGES = ("tensorboard", "wandb", "mlflow", "pytest", "pillow")
SIMULATION_TOTAL_STEPS = 50_000
SIMULATION_LOG_EVERY = 100


def _noise(step: int, metric: str, seed: int = 42) -> float:
    digest = hashlib.sha256(f"{seed}:{step}:{metric}".encode("utf-8")).digest()
    integer = int.from_bytes(digest[:8], "big")
    return (integer / 2**64) * 2 - 1


def simulated_training_points() -> list[tuple[int, dict[str, float]]]:
    points = []
    steps = list(range(0, SIMULATION_TOTAL_STEPS + 1, SIMULATION_LOG_EVERY))
    for step in steps:
        progress = step / SIMULATION_TOTAL_STEPS
        convergence = 1 - math.exp(-step / (SIMULATION_TOTAL_STEPS * 0.23))
        overfit = max(0.0, (progress - 0.82) / 0.18)
        warmup = min(1.0, step / 1_000)
        cosine = 0.5 * (1 + math.cos(math.pi * progress))
        values = {
            "train/loss": max(0.04, 1.32 * math.exp(-step / (SIMULATION_TOTAL_STEPS * 0.22)) + 0.075 + _noise(step, "train/loss") * 0.012),
            "val/loss": max(0.06, 1.38 * math.exp(-step / (SIMULATION_TOTAL_STEPS * 0.24)) + 0.14 + overfit * 0.18 + _noise(step, "val/loss") * 0.016),
            "eval/psnr": 22.4 + 4.68 * convergence - overfit * 0.18 + _noise(step, "eval/psnr") * 0.035,
            "eval/lpips": max(0.05, 0.46 - 0.275 * convergence + overfit * 0.018 + _noise(step, "eval/lpips") * 0.0025),
            "eval/ssim": 0.60 + 0.174 * convergence - overfit * 0.008 + _noise(step, "eval/ssim") * 0.0015,
            "train/learning_rate": 2e-4 * (warmup if warmup < 1 else cosine),
        }
        if step == SIMULATION_TOTAL_STEPS:
            values["eval/psnr"] = 27.08
            values["eval/lpips"] = 0.189
        points.append((step, values))
    return points


def versions() -> dict[str, str]:
    return {name: importlib.metadata.version(name) for name in PACKAGES}


def write_tensorboard_run(root: Path, points: list[tuple[int, dict[str, float]]]) -> Path:
    from PIL import Image
    from tensorboard.compat.proto.event_pb2 import Event
    from tensorboard.compat.proto.summary_pb2 import Summary
    from tensorboard.summary.writer.event_file_writer import EventFileWriter

    run_dir = root / "tensorboard" / "diffusion-sr-seed42"
    run_dir.mkdir(parents=True, exist_ok=True)
    image_buffer = BytesIO()
    Image.new("RGB", (32, 32), color=(54, 103, 148)).save(image_buffer, format="PNG")
    image_summary = Summary.Image(
        height=32,
        width=32,
        colorspace=3,
        encoded_image_string=image_buffer.getvalue(),
    )
    writer = EventFileWriter(str(run_dir))
    for step, values in points:
        summary_values = [Summary.Value(tag=key, simple_value=value) for key, value in values.items()]
        if step % 10_000 == 0:
            summary_values.append(Summary.Value(tag="qualitative/sample", image=image_summary))
        summary = Summary(value=summary_values)
        writer.add_event(Event(wall_time=time.time(), step=step, summary=summary))
    writer.flush()
    writer.close()
    return run_dir


def write_mlflow_run(root: Path, points: list[tuple[int, dict[str, float]]]) -> dict[str, str]:
    import mlflow

    tracking_dir = root / "mlflow"
    artifact_dir = tracking_dir / "artifacts"
    tracking_dir.mkdir(parents=True, exist_ok=True)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    tracking_db = (tracking_dir / "mlflow.db").resolve()
    tracking_uri = f"sqlite:///{tracking_db.as_posix()}"
    mlflow.set_tracking_uri(tracking_uri)
    experiment_name = "diffusion-sr-integration"
    client = mlflow.MlflowClient()
    experiment = client.get_experiment_by_name(experiment_name)
    if experiment is None:
        experiment_id = client.create_experiment(
            experiment_name,
            artifact_location=artifact_dir.resolve().as_uri(),
        )
        experiment = client.get_experiment(experiment_id)
    with mlflow.start_run(
        experiment_id=experiment.experiment_id,
        run_name="G1 degradation conditioning seed 42",
    ) as run:
        mlflow.log_params({"seed": 42, "conditioning": "degradation_encoder"})
        for step, values in points:
            mlflow.log_metrics({
                "psnr": values["eval/psnr"],
                "lpips": values["eval/lpips"],
                "ssim": values["eval/ssim"],
                "train_loss": values["train/loss"],
            }, step=step)
        return {
            "trackingUri": mlflow.get_tracking_uri(),
            "artifactRoot": artifact_dir.resolve().as_uri(),
            "experimentId": experiment.experiment_id,
            "experimentName": experiment.name,
            "runId": run.info.run_id,
        }


def write_wandb_run(root: Path, points: list[tuple[int, dict[str, float]]]) -> dict[str, str]:
    import wandb

    wandb_dir = root / "wandb"
    wandb_dir.mkdir(parents=True, exist_ok=True)
    previous_mode = os.environ.get("WANDB_MODE")
    os.environ["WANDB_MODE"] = "offline"
    try:
        run = wandb.init(
            project="diffusion-sr-integration",
            name="G1 degradation conditioning seed 42",
            dir=str(wandb_dir),
            config={"seed": 42, "conditioning": "degradation_encoder"},
            reinit="finish_previous",
        )
        assert run is not None
        for step, values in points:
            run.log({
                "psnr": values["eval/psnr"],
                "lpips": values["eval/lpips"],
                "ssim": values["eval/ssim"],
                "train_loss": values["train/loss"],
            }, step=step)
        run_id = run.id
        run_dir = run.dir
        run.finish()
        return {"runId": run_id, "runDir": str(run_dir)}
    finally:
        if previous_mode is None:
            os.environ.pop("WANDB_MODE", None)
        else:
            os.environ["WANDB_MODE"] = previous_mode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload: dict[str, object] = {
        "schemaVersion": "experiment-test-environment.v1",
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "isolated": sys.prefix != sys.base_prefix,
        "compatible": sys.prefix != sys.base_prefix and sys.version_info[:2] == (3, 12),
        "packages": versions(),
    }
    if args.probe:
        print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
        return 0 if payload["compatible"] else 2
    if not payload["compatible"]:
        print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
        return 2
    if args.output_dir is None:
        raise SystemExit("--output-dir is required outside probe mode")
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    points = simulated_training_points()
    payload["training"] = {
        "mode": "simulation",
        "totalSteps": SIMULATION_TOTAL_STEPS,
        "logEvery": SIMULATION_LOG_EVERY,
        "loggedSteps": len(points),
        "metrics": sorted(points[0][1]),
    }
    payload["tensorboard"] = {"runDir": str(write_tensorboard_run(root, points))}
    payload["mlflow"] = write_mlflow_run(root, points)
    payload["wandb"] = write_wandb_run(root, points)
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
