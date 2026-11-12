"""Build an evidence ledger from generated files; fail if an asserted observation is absent."""
from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

from common import inventory, write_json


def load(file):
    return json.loads(Path(file).read_text(encoding="utf-8"))


def first_existing(paths):
    return next(file for file in paths if file.exists())


def analyze(root):
    root = Path(root).resolve()
    extra = first_existing([root / part / "api-results.json" for part in ["wandb-extra-complete", "wandb-extra-verified", "wandb-extra", "follow-up/wandb-extra"]])
    mlflow = first_existing([root / part / "api-results.json" for part in ["follow-up/mlflow", "mlflow"]])
    cases = []
    for file in [root / "wandb/api-results.json", extra, root / "tensorboard/api-results.json", root / "tensorboard-extra/api-results.json", mlflow]:
        value = load(file)
        for case in value["cases"]:
            cases.append({"product": value["product"], "evidence": file.relative_to(root).as_posix(), **case})
    wandb, tensorboard = load(root / "inspection/wandb.json"), load(root / "inspection/tensorboard.json")
    rich = next(file for file in wandb if "/wandb/offline-run-" in file["relativeFile"] and "rich-run" in file["relativeFile"] and len(file["history"]) > 5)
    extra_prefix = extra.parent.relative_to(root).as_posix()
    wb_extra = next(file for file in wandb if file["relativeFile"].startswith(extra_prefix + "/"))
    checks = {}
    def check(name, condition, evidence):
        checks[name] = {"passed": bool(condition), "evidence": evidence}
    check("no-unexpected-api-errors", not any(case["status"] == "error" for case in cases), "selected */api-results.json")
    check("wandb-custom-axis-recorded", any(item.get("step_metric") == "epoch" for item in rich["metricDefinitions"]), "inspection/wandb.json: metricDefinitions")
    check("wandb-rich-media-recorded", all(kind in rich["mediaTypes"] for kind in ["image-file", "mask", "boxes2D", "audio-file", "video-file", "histogram", "table-file", "incremental-table-file", "html-file", "object3D-file", "plotly-file"]), "inspection/wandb.json: mediaTypes")
    check("wandb-metadata-and-artifacts-recorded", len(rich["artifacts"]) >= 5 and rich["recordTypes"].get("config", 0) > 1, "inspection/wandb.json: artifacts/config")
    check("wandb-console-recorded", wb_extra["recordTypes"].get("output_raw", 0) > 0, "inspection/wandb.json: output_raw")
    entries = [entry for run in [rich, wb_extra] for artifact in run["artifacts"] for entry in artifact.get("manifest", {}).get("contents", [])]
    local = [Path(entry["local_path"]) for entry in entries if entry.get("local_path")]
    check("wandb-artifact-staged-contents-available", bool(local) and all(file.is_file() for file in local), "artifact manifest local_path entries")
    partitioned = [entry for entry in entries if entry.get("path", "").endswith(".partitioned-table.json")]
    check("wandb-partitioned-table-file-recorded", bool(partitioned) and all(load(entry["local_path"]).get("_type") == "partitioned-table" for entry in partitioned), "artifact manifest + staged partitioned-table JSON")
    rows = wb_extra["history"]
    check("wandb-mutable-table-versions-recorded", [row["table/mutable/nrows"] for row in rows if "table/mutable/nrows" in row] == [1, 2], "inspection/wandb.json: successive mutable table records")
    check("wandb-commit-false-merges-fields", any("edge/partial_a" in row and "edge/partial_b" in row for row in rows), "inspection/wandb.json: explicit commit row")
    check("wandb-explicit-committed-steps-rejected", not any("edge/dropped_same_step" in row or "edge/dropped_backward_step" in row for row in rows), "inspection/wandb.json: absence after explicit committed step")
    type_counts, plugins = collections.Counter(), collections.Counter()
    for file in tensorboard:
        type_counts.update(file["valueTypes"])
        plugins.update(file["plugins"])
    check("tensorboard-rich-plugins-recorded", all(name in plugins for name in ["scalars", "text", "pr_curves", "custom_scalars", "mesh", "hparams", "synthetic_custom"]), "inspection/tensorboard.json: plugins")
    check("tensorboard-media-and-distributions-recorded", all(name in type_counts for name in ["image", "audio", "histo", "tensor"]), "inspection/tensorboard.json: valueTypes")
    check("tensorboard-graph-and-run-metadata-recorded", any(event["kind"] == "graph_def" for file in tensorboard for event in file["events"]) and any(event["kind"] == "tagged_run_metadata" for file in tensorboard for event in file["events"]), "inspection/tensorboard.json: graph/run metadata events")
    embeddings = [file.relative_to(root).as_posix() for file in root.rglob("projector_config.pbtxt")]
    check("embedding-needs-sidecars", bool(embeddings) and any(root.rglob("tensors.tsv")) and any(root.rglob("metadata.tsv")), "projector_config.pbtxt + TSV + sprite files")
    accumulator = load(root / "inspection/tensorboard-accumulator.json")
    restart = [item for item in accumulator if item["directory"] == "tensorboard-extra/native-restart"]
    counts = {str(item["purge"]): len(item["scalars"]["restart/loss"]) for item in restart}
    check("tensorboard-restart-purge-changes-view", counts == {"True": 4, "False": 6}, "inspection/tensorboard-accumulator.json: native-restart")
    partial = load(root / "partial-files/observations.json")
    check("tensorboard-partial-record-resumes", partial["tensorboard-tail-resume"]["noLostOrDuplicatedEvents"], "partial-files/observations.json")
    check("wandb-partial-record-requires-wait", all(value["partial"]["readError"] and not value["completed"]["readError"] for name, value in partial.items() if name.startswith("wandb-")), "partial-files/observations.json")
    readers = load(root / "current-topolumia-reader/summary.json")
    rich_read = next(file for file in readers if file["provider"] == "wandb")
    lines = rich_read["runs"][0]["series"]
    false_metrics = [line["key"] for line in lines if line["key"].startswith(("media/", "table/", "plot/"))]
    check("current-reader-treats-media-metadata-as-curves", bool(false_metrics), "current-topolumia-reader/summary.json")
    check("current-reader-loses-defined-custom-axis", any(line["key"] == "val/psnr" and line["xKey"] == "step" for line in lines), "current-topolumia-reader/summary.json vs metricDefinitions")
    ml_runs = load(mlflow.parent / "decoded-runs.json")
    parent = next(run for run in ml_runs if len(run["histories"].get("train/loss", [])) >= 5)
    check("mlflow-repeated-and-negative-steps-preserved", [int(point["step"]) for point in parent["histories"]["train/loss"]] == [10, 10, 2, -1, 20], "MLflow decoded-runs.json")
    check("mlflow-input-lineage-recorded", bool(parent["inputs"].get("dataset_inputs")), "MLflow decoded-runs.json: inputs")
    check("mlflow-failure-recorded", any(run["info"]["status"] == "FAILED" for run in ml_runs), "MLflow decoded-runs.json: status")
    live = load(root / "follow-up/summary.json") if (root / "follow-up/summary.json").exists() else load(root / "research-summary.json")["live"]
    wb_default = live.get("wandb-committed-default", live.get("wandb"))
    wb_fast = live.get("wandb-fast")
    check("wandb-committed-log-grows-live", bool(wb_default and wb_default.get("grewBeforeFinish")), "committed default W&B observations")
    check("wandb-configured-fast-log-grows-live", bool(wb_fast and wb_fast.get("grewBeforeFinish")), "configured 1s W&B observations")
    initial = load(root / "research-summary.json")
    check("tensorboard-official-and-x-grow-live", all(initial["live"][name].get("grewBeforeFinish") for name in ["tensorboard", "tensorboard-native"]), "research-summary.json: live")
    report = {"caseCount": len(cases), "statuses": dict(collections.Counter(case["status"] for case in cases)), "cases": cases,
              "checks": checks, "checksPassed": sum(item["passed"] for item in checks.values()),
              "wandbRecordTypes": rich["recordTypes"], "wandbMediaTypes": rich["mediaTypes"],
              "tensorboardValueTypes": dict(type_counts), "tensorboardPlugins": dict(plugins),
              "currentReaderFalseScalarMetrics": false_metrics, "embeddingConfigurations": embeddings}
    write_json(root / "evidence-ledger.json", report)
    inventory(root, root / "file-manifest.json")
    failed = [name for name, item in checks.items() if not item["passed"]]
    print(json.dumps({"cases": len(cases), "statuses": report["statuses"], "checksPassed": report["checksPassed"], "failedChecks": failed}))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    analyze(parser.parse_args().output)
