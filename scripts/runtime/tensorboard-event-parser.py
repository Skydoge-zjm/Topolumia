#!/usr/bin/env python3
"""Small JSON sidecar for TensorBoard protobuf event files.

The Node adapter treats this as an optional process boundary so the gateway
does not take a hard Python/TensorFlow dependency. Install `tensorboard` in the
selected Python environment before configuring this script as the parser.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--logdir")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--format", choices=["json"], default="json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        import tensorboard
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
    except ImportError:
        print("Install the 'tensorboard' Python package to parse protobuf event files.", file=sys.stderr)
        return 2

    if args.probe:
        print(json.dumps({"status": "ready", "tensorboard": tensorboard.__version__}))
        return 0

    if not args.logdir:
        raise SystemExit("--logdir is required unless --probe is used")
    logdir = Path(args.logdir).resolve()
    if not logdir.is_dir():
        raise SystemExit(f"logdir does not exist: {logdir}")

    accumulator = EventAccumulator(str(logdir), size_guidance={"scalars": 0, "images": 256})
    accumulator.Reload()
    tags = accumulator.Tags()
    scalars: dict[str, list[dict[str, float | int]]] = {}
    for tag in tags.get("scalars", []):
        scalars[tag] = [
            {"step": event.step, "value": event.value, "timestamp": event.wall_time}
            for event in accumulator.Scalars(tag)
        ]

    images: list[dict[str, str | int | float]] = []
    for tag in tags.get("images", []):
        for event in accumulator.Images(tag):
            images.append({
                "tag": tag,
                "step": event.step,
                "timestamp": event.wall_time,
                "width": event.width,
                "height": event.height,
                "mimeType": "image/png",
            })

    print(json.dumps({
        "name": logdir.name,
        "scalars": scalars,
        "images": images,
        "tags": {
            "histograms": tags.get("histograms", []),
            "tensors": tags.get("tensors", []),
            "audio": tags.get("audio", []),
        },
    }, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
