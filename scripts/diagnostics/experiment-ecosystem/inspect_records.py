"""Inspect complete protobuf records and compare raw versus public reader views."""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

from common import safe, write_json

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))


def wandb_file(file, decoded=None):
    from wandb.proto import wandb_internal_pb2
    from wandb_record_reader import WandbRecordReader
    from google.protobuf.json_format import MessageToDict
    result = {"file": str(file), "recordTypes": {}, "history": [], "metricDefinitions": [], "summaries": [],
              "config": [], "artifacts": [], "run": [], "exit": [], "mediaTypes": {}, "readError": None}
    counts = collections.Counter()
    media = collections.Counter()
    reader = None
    output = Path(decoded).open("w", encoding="utf-8") if decoded else None
    try:
        reader = WandbRecordReader(file)
        while True:
            offset = reader.file.tell()
            data = reader.scan_data()
            if data is None:
                result["lastCompleteOffset"] = offset
                break
            record = wandb_internal_pb2.Record()
            record.ParseFromString(data)
            kind = record.WhichOneof("record_type")
            counts[kind] += 1
            value = MessageToDict(record, preserving_proto_field_name=True)
            if output:
                output.write(json.dumps({"offset": offset, "record": value}, ensure_ascii=False) + "\n")
            if kind == "history":
                row = {}
                for item in record.history.item:
                    key = "/".join(item.nested_key) if item.nested_key else item.key
                    try:
                        row[key] = json.loads(item.value_json)
                    except ValueError:
                        row[key] = {"invalidJson": item.value_json}
                result["history"].append(safe(row))
                for key, item in row.items():
                    if key.endswith("/_type"):
                        media[str(item)] += 1
                def media_types(item):
                    if isinstance(item, dict):
                        if "_type" in item:
                            media[str(item["_type"])] += 1
                        for child in item.values():
                            media_types(child)
                    elif isinstance(item, list):
                        for child in item:
                            media_types(child)
                media_types(row)
            elif kind == "metric":
                result["metricDefinitions"].append(value.get(kind))
            elif kind in ["summary", "config", "artifact", "run", "exit"]:
                target = {"summary": "summaries", "artifact": "artifacts"}.get(kind, kind)
                result[target].append(value.get(kind))
            result["lastCompleteOffset"] = reader.file.tell()
    except Exception as error:
        result["readError"] = {"type": type(error).__name__, "message": str(error), "offset": reader.file.tell() if reader else 0}
    finally:
        if reader:
            reader.close()
        if output:
            output.close()
    result["recordTypes"] = dict(counts)
    result["mediaTypes"] = dict(media)
    result["bytes"] = Path(file).stat().st_size
    return result


def tensorboard_file(file, decoded=None):
    from tensorboard.backend.event_processing.event_file_loader import RawEventFileLoader
    from tensorboard.compat.proto.event_pb2 import Event
    from tensorboard.util import tensor_util
    from google.protobuf.json_format import MessageToDict
    result = {"file": str(file), "events": [], "plugins": {}, "valueTypes": {}, "readError": None}
    plugins, types = collections.Counter(), collections.Counter()
    output = Path(decoded).open("w", encoding="utf-8") if decoded else None
    try:
        for index, raw in enumerate(RawEventFileLoader(str(file)).Load()):
            event = Event.FromString(raw)
            kind = event.WhichOneof("what")
            entry = {"index": index, "kind": kind, "step": event.step, "wallTime": event.wall_time}
            if output:
                output.write(json.dumps({"index": index, "event": MessageToDict(event, preserving_proto_field_name=True)}, ensure_ascii=False) + "\n")
            if kind == "summary":
                values = []
                for item in event.summary.value:
                    value_type = item.WhichOneof("value")
                    plugin = item.metadata.plugin_data.plugin_name
                    types[value_type] += 1
                    if plugin:
                        plugins[plugin] += 1
                    value = {"tag": item.tag, "kind": value_type, "plugin": plugin,
                             "metadataBytes": len(item.metadata.plugin_data.content)}
                    if value_type == "simple_value":
                        value["value"] = item.simple_value
                    elif value_type == "tensor":
                        array = tensor_util.make_ndarray(item.tensor)
                        value.update({"dtype": str(array.dtype), "shape": list(array.shape),
                                      "value": array.tolist() if array.size <= 12 else None})
                    elif value_type in ["image", "audio"]:
                        value["encodedBytes"] = len(getattr(item, value_type).SerializeToString())
                    elif value_type == "histo":
                        value.update({"num": item.histo.num, "bucketCount": len(item.histo.bucket)})
                    values.append(value)
                entry["values"] = values
            elif kind == "session_log":
                entry["status"] = event.session_log.status
            elif kind == "file_version":
                entry["version"] = event.file_version
            result["events"].append(entry)
    except Exception as error:
        result["readError"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if output:
            output.close()
    result.update({"plugins": dict(plugins), "valueTypes": dict(types), "bytes": Path(file).stat().st_size})
    return result


def inspect_all(root):
    from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
    root = Path(root)
    output = root / "inspection"
    output.mkdir(exist_ok=True)
    wandb = []
    for index, file in enumerate(sorted(root.rglob("*.wandb"))):
        value = wandb_file(file, output / f"wandb-{index:02d}.jsonl")
        value["relativeFile"] = file.relative_to(root).as_posix()
        wandb.append(value)
    events = []
    for index, file in enumerate(sorted(root.rglob("*tfevents*"))):
        if not file.is_file() or "inspection" in file.parts:
            continue
        value = tensorboard_file(file, output / f"tensorboard-{index:02d}.jsonl")
        value["relativeFile"] = file.relative_to(root).as_posix()
        events.append(value)
    directories = []
    for directory in sorted({file.parent for file in root.rglob("*tfevents*") if file.is_file()}):
        for purge in [True, False]:
            try:
                accumulator = EventAccumulator(str(directory), size_guidance={"scalars": 0, "tensors": 0, "histograms": 0, "images": 0, "audio": 0}, purge_orphaned_data=purge)
                accumulator.Reload()
                tags = accumulator.Tags()
                scalars = {tag: [{"step": point.step, "value": point.value} for point in accumulator.Scalars(tag)] for tag in tags.get("scalars", [])}
                directories.append({"directory": directory.relative_to(root).as_posix(), "purge": purge, "tags": tags, "scalars": scalars})
            except Exception as error:
                directories.append({"directory": str(directory), "purge": purge, "error": str(error)})
    write_json(output / "wandb.json", wandb)
    write_json(output / "tensorboard.json", events)
    write_json(output / "tensorboard-accumulator.json", directories)
    return {"wandbFiles": len(wandb), "eventFiles": len(events), "wandbReadErrors": sum(bool(f["readError"]) for f in wandb), "tensorboardReadErrors": sum(bool(f["readError"]) for f in events)}
