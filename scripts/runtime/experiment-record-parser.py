#!/usr/bin/env python3
"""Read native experiment records with their providers' existing readers."""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
from pathlib import Path


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def tensorboard_record(file: Path, label: str):
    try:
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
        from tensorboard.util import tensor_util
    except ImportError as error:
        raise RuntimeError("读取 TensorBoard event 文件需要在实验记录读取器的 Python 环境中安装 tensorboard。") from error
    # Asset storage uses an opaque basename. TensorBoard selects its loader by
    # the "tfevents" filename, so expose a temporary read-only name for it.
    with tempfile.TemporaryDirectory(prefix="topolumia-tensorboard-") as directory:
        event_file = Path(directory) / "events.out.tfevents.import"
        try:
            os.link(file, event_file)
        except OSError:
            shutil.copyfile(file, event_file)
        accumulator = EventAccumulator(str(event_file), size_guidance={"scalars": 0, "tensors": 0}, purge_orphaned_data=False)
        accumulator.Reload()
    series = []
    for key in accumulator.Tags().get("scalars", []):
        points = [{"x": event.step, "y": event.value, "timestamp": event.wall_time}
                  for event in accumulator.Scalars(key) if number(event.value)]
        series.append({"key": key, "xKey": "step", "points": points})
    for key in accumulator.Tags().get("tensors", []):
        if any(item["key"] == key for item in series):
            continue
        points = []
        for event in accumulator.Tensors(key):
            array = tensor_util.make_ndarray(event.tensor_proto)
            if array.size == 1:
                value = array.item()
                if number(value):
                    points.append({"x": event.step, "y": value, "timestamp": event.wall_time})
        if points:
            series.append({"key": key, "xKey": "step", "points": points})
    return [{"sourceId": label, "label": label, "status": "unknown", "series": series}]


def wandb_record(file: Path, label: str):
    try:
        from wandb.proto import wandb_internal_pb2
    except ImportError as error:
        raise RuntimeError("读取原生 .wandb 文件需要在实验记录读取器的 Python 环境中安装 wandb。") from error
    from wandb_record_reader import WandbRecordReader
    store = WandbRecordReader(file)
    rows, summary, params = [], {}, {}
    run_id, project, entity, name, status = file.stem, "", "", label, "unknown"
    try:
        while True:
            data = store.scan_data()
            if data is None:
                break
            record = wandb_internal_pb2.Record()
            record.ParseFromString(data)
            kind = record.WhichOneof("record_type")
            if kind == "run":
                run_id = record.run.run_id or run_id
                project, entity = record.run.project, record.run.entity
                name = record.run.display_name or name
            elif kind == "history":
                row = {}
                for item in record.history.item:
                    key = "/".join(item.nested_key) if item.nested_key else item.key
                    try:
                        row[key] = json.loads(item.value_json)
                    except (ValueError, TypeError):
                        pass
                if "_step" not in row and record.history.HasField("step"):
                    row["_step"] = record.history.step.num
                rows.append(row)
            elif kind == "summary":
                for item in record.summary.update:
                    key = "/".join(item.nested_key) if item.nested_key else item.key
                    try:
                        value = json.loads(item.value_json)
                        if number(value):
                            summary[key] = value
                    except (ValueError, TypeError):
                        pass
            elif kind == "config":
                for item in record.config.update:
                    key = "/".join(item.nested_key) if item.nested_key else item.key
                    try:
                        params[key] = json.loads(item.value_json)
                    except (ValueError, TypeError):
                        pass
            elif kind == "exit":
                status = "succeeded" if record.exit.exit_code == 0 else "failed"
    finally:
        store.close()
    series = {}
    for index, row in enumerate(rows):
        step = row.get("_step")
        has_step = number(step)
        for key, value in row.items():
            if not key.startswith("_") and number(value):
                axis = "step" if has_step else "recordIndex"
                item = series.setdefault((key, axis), {"key": key, "xKey": axis, "points": []})
                item["points"].append({"x": step if has_step else index, "y": value,
                                       "timestamp": row.get("_timestamp") if number(row.get("_timestamp")) else None})
    source_id = "/".join(part for part in (entity, project, run_id) if part)
    return [{"sourceId": source_id, "label": name, "status": status, "params": params,
             "metrics": summary, "series": list(series.values())}]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=("wandb", "tensorboard"))
    parser.add_argument("--file", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    file = Path(args.file)
    runs = wandb_record(file, args.label) if args.provider == "wandb" else tensorboard_record(file, args.label)
    print(json.dumps({"runs": runs}, ensure_ascii=True, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
