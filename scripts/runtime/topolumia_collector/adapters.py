"""Adapters only decode native records. Queueing, identity and HTTP are shared.

read(file, offset, context) -> (new_offset, normalized_events, attachments).
An incomplete tail returns None without advancing the persisted cursor.
Unknown data is archived as its protobuf bytes, with explicit extension events.
"""
from __future__ import annotations
import base64
import fnmatch
import hashlib
import json
import math
import struct
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def numeric(value, dtype=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, int) and not -(2**63) <= value < 2**64:
        return None
    if isinstance(value, int) and (abs(value) > 2**53 - 1 or dtype in ("int64", "uint64")):
        return {"dtype": dtype or ("uint64" if value >= 2**63 else "int64"), "value": str(value)}
    if isinstance(value, float) and not math.isfinite(value):
        return {"dtype": dtype or "float64", "value": "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"}
    return {"dtype": dtype, "value": repr(value)} if dtype in ("float32", "float64") else value


def safe(value):
    if isinstance(value, dict):
        return {str(k): safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe(v) for v in value]
    n = numeric(value)
    return n if n is not None else value


def raw_event(raw, provider, kind, attachments):
    if len(raw) <= 65536:
        return {"kind": "extension", "key": "native/" + str(kind), "data": {"provider": provider, "encoding": "protobuf-base64", "value": base64.b64encode(raw).decode("ascii")}}
    checksum = digest(raw)
    attachments[checksum] = raw
    return {"kind": "extension", "key": "native/" + str(kind), "data": {"provider": provider, "encoding": "protobuf", "attachments": [{"sha256": checksum, "name": str(kind) + ".pb"}]}}


def flat_items(items):
    result = {}
    for item in items:
        key = "/".join(item.nested_key) if item.nested_key else item.key
        try:
            result[key] = json.loads(item.value_json)
        except (ValueError, TypeError):
            result[key] = {"invalidJson": item.value_json}
    return result


def wandb_values(row):
    """Keep typed/media subtrees intact, even when W&B flattens their keys."""
    typed = {key[:-6] for key in row if key.endswith("/_type")}
    typed |= {key for key, value in row.items() if isinstance(value, dict) and "_type" in value}
    consumed = set()
    for root in sorted(typed, key=len):
        if any(root.startswith(parent + "/") for parent in consumed):
            continue
        value = row.get(root)
        if not isinstance(value, dict):
            value = {key[len(root) + 1:]: child for key, child in row.items() if key.startswith(root + "/")}
        consumed.add(root)
        yield root, value
    def walk(key, value):
        if isinstance(value, dict) and "_type" not in value:
            for child, item in value.items():
                yield from walk(key + "/" + str(child), item)
        else:
            yield key, value
    for key, value in row.items():
        if key.startswith("_") or any(key == root or key.startswith(root + "/") for root in consumed):
            continue
        yield from walk(key, value)


def file_digest(file, cache):
    info = file.stat()
    signature = (info.st_ino, info.st_size, info.st_mtime_ns)
    previous = cache.get(str(file)) if cache is not None else None
    if previous and previous[0] == signature:
        return previous[1]
    checksum = hashlib.sha256()
    with file.open("rb") as source:
        while chunk := source.read(65536):
            checksum.update(chunk)
    value = checksum.hexdigest()
    if cache is not None:
        cache[str(file)] = (signature, value)
        if len(cache) > 512:
            cache.pop(next(iter(cache)))
    return value


def media_files(value, root, attachments, allowed_root=None, cache=None):
    refs, missing = [], []
    def visit(item):
        if isinstance(item, dict):
            for key, child in item.items():
                if key in ("path", "local_path") and isinstance(child, str):
                    file = (root / child).resolve()
                    if not file.is_relative_to((allowed_root or root).resolve()) or not file.is_file():
                        missing.append(child)
                    elif file.stat().st_size > 64 * 1024 * 1024:
                        missing.append(child + " (over 64 MiB)")
                    else:
                        checksum = file_digest(file, cache)
                        if isinstance(item.get("sha256"), str) and len(item["sha256"]) == 64 and item["sha256"] != checksum:
                            missing.append(child + " (checksum does not match native record)")
                            continue
                        attachments[checksum] = file
                        refs.append({"sha256": checksum, "name": child})
                else:
                    visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)
    visit(value)
    return refs, missing


class WandbAdapter:
    provider = "wandb"
    initial_offset = 7

    def __init__(self):
        self.attachment_cache = {}

    def read(self, file, offset, context):
        from wandb.proto import wandb_internal_pb2 as pb
        from wandb_record_reader import WandbRecordReader
        reader = WandbRecordReader(file)
        try:
            reader.file.seek(offset)
            try:
                raw = reader.scan_data()
            except ValueError as error:
                # Native writers may expose only the head of a transaction.
                if "Incomplete" in str(error) or "incomplete file" in str(error):
                    return None
                raise
            if raw is None:
                return None
            end = reader.file.tell()
        finally:
            reader.close()
        record = pb.Record.FromString(raw)
        kind = record.WhichOneof("record_type")
        attachments = {}
        events = [raw_event(raw, self.provider, kind, attachments)]
        if kind == "run":
            context["run"] = record.run.run_id or file.stem.removeprefix("run-")
            context["source_id"] = "/".join(part for part in (record.run.entity, record.run.project, record.run.run_id) if part)
            events.append({"kind": "run", "label": record.run.display_name or record.run.run_id or file.stem, "status": "running"})
            if record.run.config.update:
                events.append({"kind": "config", "data": {"update": safe(flat_items(record.run.config.update)), "remove": []}})
        elif kind == "metric":
            metric = record.metric
            name = metric.name or metric.glob_name
            if name:
                definitions = context.setdefault("metrics", {})
                step_key = metric.step_metric
                if not step_key and metric.step_metric_index:
                    step_key = context.setdefault("metric_order", []).copy()[metric.step_metric_index - 1] if metric.step_metric_index <= len(context.get("metric_order", [])) else ""
                definitions[name] = {"axis": step_key, "step_sync": metric.options.step_sync}
                context.setdefault("metric_order", []).append(name)
                if step_key:
                    events.append({"kind": "metric", "key": name, "xKey": step_key})
        elif kind == "history":
            row = flat_items(record.history.item)
            step = row.get("_step", record.history.step.num if record.history.HasField("step") else context.get("record_index", 0))
            previous = context.setdefault("axis_values", {})
            current_values = dict(wandb_values(row))
            for key, value in current_values.items():
                number = numeric(value)
                if number is not None:
                    definition = context.get("metrics", {}).get(key)
                    if definition is None:
                        definition = next((definition for pattern, definition in reversed(list(context.get("metrics", {}).items())) if fnmatch.fnmatchcase(key, pattern)), {})
                    axis = definition.get("axis") or "step"
                    x = step if axis == "step" else current_values.get(axis, previous.get(axis) if definition.get("step_sync") else None)
                    if numeric(x) is not None:
                        events.append({"kind": "scalar", "key": key, "xKey": axis, "x": numeric(x), "value": number, **({"timestamp": row["_timestamp"]} if isinstance(row.get("_timestamp"), (int, float)) and math.isfinite(row["_timestamp"]) else {})})
                    else:
                        events.append({"kind": "extension", "key": key, "data": {"reason": "missing-custom-axis", "xKey": axis, "value": safe(value)}})
                elif isinstance(value, dict) and "_type" in value:
                    native = str(value["_type"])
                    event_kind = "table" if "table" in native else "distribution" if "histogram" in native else "media"
                    refs, missing = media_files(value, file.parent / "files", attachments, cache=self.attachment_cache)
                    events.append({"kind": event_kind, "key": key, "data": {"native": safe(value), "attachments": refs, "missingDependencies": missing, "step": safe(step)}})
                else:
                    events.append({"kind": "extension", "key": key, "data": {"value": safe(value), "step": safe(step)}})
            axes = {definition.get("axis") for definition in context.get("metrics", {}).values()}
            previous.update({key: value for key, value in current_values.items() if key in axes and numeric(value) is not None})
        elif kind in ("config", "summary"):
            message = getattr(record, kind)
            events.append({"kind": kind, "data": {"update": safe(flat_items(message.update)), "remove": ["/".join(item.nested_key) if item.nested_key else item.key for item in message.remove]}})
        elif kind in ("files", "artifact"):
            if kind == "files":
                native = {"files": [{"path": entry.path, "policy": entry.policy} for entry in record.files.files]}
                paths = [{"path": entry.path} for entry in record.files.files]
            else:
                from google.protobuf.json_format import MessageToDict
                native = MessageToDict(record.artifact, preserving_proto_field_name=True)
                paths = [{"local_path": entry.local_path} for entry in record.artifact.manifest.contents if entry.local_path]
            refs, missing = media_files(paths, file.parent / "files", attachments, cache=self.attachment_cache)
            events.append({"kind": "file", "key": "wandb/" + kind, "data": {"native": safe(native), "attachments": refs, "missingDependencies": missing}})
        elif kind == "exit":
            events.append({"kind": "lifecycle", "data": {"status": "succeeded" if record.exit.exit_code == 0 else "failed", "evidence": "native-exit", "exitCode": record.exit.exit_code}})
            context["finished"] = True
        context["record_index"] = context.get("record_index", 0) + 1
        run = context.get("run", file.stem.removeprefix("run-"))
        for event in events:
            event["sourceRunId"] = run
        return end, events, attachments


class TensorBoardAdapter:
    provider = "tensorboard"
    initial_offset = 0

    def __init__(self):
        self.attachment_cache = {}

    def read(self, file, offset, context):
        from tensorboard.compat.tensorflow_stub.pywrap_tensorflow import masked_crc32c
        from tensorboard.compat.proto.event_pb2 import Event
        from tensorboard.util import tensor_util
        with file.open("rb") as stream:
            stream.seek(offset)
            head = stream.read(12)
            if len(head) < 12:
                return None
            length, checksum = struct.unpack("<QI", head)
            if length > 64 * 1024 * 1024 or masked_crc32c(head[:8]) != checksum:
                raise ValueError("Invalid TensorBoard TFRecord header")
            raw, tail = stream.read(length), stream.read(4)
            if len(raw) < length or len(tail) < 4:
                return None
            if masked_crc32c(raw) != struct.unpack("<I", tail)[0]:
                raise ValueError("Invalid TensorBoard TFRecord checksum")
            end = stream.tell()
        record = Event.FromString(raw)
        kind = record.WhichOneof("what")
        attachments = {}
        events = [raw_event(raw, self.provider, kind, attachments)]
        run = context.get("run", file.parent.name)
        if offset == 0:
            events.append({"kind": "run", "label": file.parent.name, "status": "unknown"})
        if kind == "summary":
            for value in record.summary.value:
                tag, value_kind = value.tag, value.WhichOneof("value")
                plugin = value.metadata.plugin_data.plugin_name
                if plugin and plugin != "scalars":
                    context.setdefault("plugins", {})[tag] = plugin
                plugin = plugin or context.get("plugins", {}).get(tag, "")
                n = numeric(value.simple_value, "float32") if value_kind == "simple_value" else None
                if value_kind == "tensor" and plugin in ("", "scalars"):
                    array = tensor_util.make_ndarray(value.tensor)
                    if array.size == 1 and array.dtype.kind in "iuf":
                        n = numeric(array.item(), str(array.dtype))
                if n is not None:
                    events.append({"kind": "scalar", "key": tag, "xKey": "step", "x": numeric(record.step), "value": n, "timestamp": record.wall_time})
                elif value_kind in ("image", "audio"):
                    media = getattr(value, value_kind)
                    data = media.encoded_image_string if value_kind == "image" else media.encoded_audio_string
                    checksum = digest(data); attachments[checksum] = data
                    events.append({"kind": "media", "key": tag, "data": {"type": value_kind, "step": numeric(record.step), "attachments": [{"sha256": checksum, "name": tag, "mediaType": "image/png" if value_kind == "image" else media.content_type}]}})
                elif value_kind == "histo":
                    hist = value.histo
                    events.append({"kind": "distribution", "key": tag, "data": {"min": safe(hist.min), "max": safe(hist.max), "num": safe(hist.num), "buckets": safe(list(hist.bucket)), "limits": safe(list(hist.bucket_limit)), "step": numeric(record.step)}})
                else:
                    events.append({"kind": "extension", "key": tag, "data": {"plugin": plugin, "valueType": value_kind, "step": numeric(record.step), "rawRecord": digest(raw)}})
        elif kind == "session_log":
            events.append({"kind": "lifecycle", "data": {"status": "unknown", "evidence": "tensorboard-session", "sessionStatus": record.session_log.status, "step": numeric(record.step), "displayPolicy": "all-observations"}})
        for event in events:
            event["sourceRunId"] = run
        return end, events, attachments


    def sidecars(self, root):
        from google.protobuf import text_format
        from google.protobuf.json_format import MessageToDict
        from tensorboard.plugins.projector.projector_config_pb2 import ProjectorConfig
        for config in root.rglob("projector_config.pbtxt"):
            if config.is_symlink() or config.stat().st_size > 1024 * 1024:
                continue
            raw = config.read_bytes()
            native, missing, paths = {}, [], []
            try:
                message = text_format.Parse(raw.decode("utf-8"), ProjectorConfig())
                native = MessageToDict(message, preserving_proto_field_name=True)
                for embedding in message.embeddings:
                    paths.extend({"path": name} for name in (embedding.tensor_path, embedding.metadata_path, embedding.sprite.image_path) if name)
            except (ValueError, UnicodeError, text_format.ParseError) as error:
                missing.append("projector config: " + str(error)[:200])
            attachments = {digest(raw): raw}
            refs, dependencies = media_files(paths, config.parent, attachments, allowed_root=root, cache=self.attachment_cache)
            refs.insert(0, {"sha256": digest(raw), "name": str(config.relative_to(root))})
            relative = str(config.parent.relative_to(root))
            yield str(config), relative, {"kind": "file", "key": "tensorboard/projector", "sourceRunId": relative if relative != "." else config.parent.name, "data": {"native": safe(native), "attachments": refs, "missingDependencies": missing + dependencies}}, attachments


ADAPTERS = {"wandb": WandbAdapter, "tensorboard": TensorBoardAdapter}
