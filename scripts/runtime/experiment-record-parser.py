#!/usr/bin/env python3
"""Static imports reuse the incremental native decoder used by the collector."""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path
from topolumia_collector.adapters import ADAPTERS


def finite(value):
    if isinstance(value, dict) and "value" in value:
        try:
            value = float(value["value"])
        except ValueError:
            return None
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def read_native(provider, file, label):
    adapter = ADAPTERS[provider]()
    context = {"run": label.removeprefix("run-").removesuffix(".wandb") if provider == "wandb" else label}
    offset, series, params, summary, status, name, warnings = adapter.initial_offset, {}, {}, {}, "unknown", label, []
    typed_count, preserved_count, rich_events = 0, 0, []
    while True:
        result = adapter.read(file, offset, context)
        if result is None:
            break
        offset, events, _attachments = result
        for event in events:
            event = dict(event)
            event.setdefault("sourceRunId", context.get("source_id", context.get("run", label)))
            event["seq"] = len(rich_events)
            rich_events.append(event)
            kind = event["kind"]
            if kind == "run":
                name, status = event["label"], event["status"]
            elif kind == "scalar":
                x, y = finite(event["x"]), finite(event["value"])
                if isinstance(event["x"], dict) or isinstance(event["value"], dict):
                    typed_count += 1
                identity = (event["key"], event["xKey"])
                item = series.setdefault(identity, {"key": event["key"], "xKey": event["xKey"], "points": []})
                point = {"x": x if x is not None else 0, "y": y if y is not None else 0}
                if isinstance(event["x"], dict):
                    point["originalX"] = event["x"]
                if isinstance(event["value"], dict):
                    point["originalY"] = event["value"]
                if x is None or y is None:
                    point["nonFinite"] = True
                if "timestamp" in event:
                    point["timestamp"] = event["timestamp"]
                item["points"].append(point)
            elif kind in ("config", "summary"):
                target = params if kind == "config" else summary
                target.update(event["data"].get("update", {}))
                for key in event["data"].get("remove", []):
                    target.pop(key, None)
            elif kind == "lifecycle" and event["data"].get("evidence") == "native-exit":
                status = event["data"]["status"]
            else:
                preserved_count += 1
                if event.get("data", {}).get("missingDependencies"):
                    warnings.append({"key": event.get("key"), "missingDependencies": event["data"]["missingDependencies"]})
    return [{"sourceId": context.get("source_id", context.get("run", label)), "label": name, "status": status, "series": list(series.values()), "params": params,
             "events": rich_events,
             "metrics": {key: value for key, value in summary.items() if isinstance(value, (float, int)) and finite(value) is not None},
             "nativeSemantics": {"typedNumberCount": typed_count, "preservedRecordCount": preserved_count, "warnings": warnings, "restartPolicy": "all-observations", "completeOffset": offset}}]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=tuple(ADAPTERS))
    parser.add_argument("--file", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    print(json.dumps({"runs": read_native(args.provider, Path(args.file), args.label)}, ensure_ascii=True, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
