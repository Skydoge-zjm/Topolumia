"""Run actual SDK experiments in a dedicated venv; writes synthetic data only.

Example: python scripts/diagnostics/experiment-ecosystem/probe.py --output runtime/experiment-ecosystem-research/data
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from common import inventory, isolated_env, versions, write_json

SCRIPT = Path(__file__).resolve()
REPO = SCRIPT.parents[3]


def wait_for(action, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = action()
        if result:
            return result
        time.sleep(.15)
    return None


def worker(product, output):
    if product == "wandb":
        from wandb_probe import run
    elif product == "tensorboard":
        from tensorboard_probe import run
    elif product == "mlflow":
        from mlflow_probe import run
    elif product in ["wandb-live", "wandb-crash", "wandb-burst-live", "wandb-fast-live"]:
        from wandb_probe import live_writer
        live_writer(output, crash=product.endswith("crash"), burst="burst" in product, flush_interval=1 if "fast" in product else None)
        return
    elif product in ["tensorboard-live", "tensorboard-native-live"]:
        from tensorboard_probe import live_writer
        live_writer(output, native="native" in product)
        return
    elif product == "tensorboard-extra":
        from tensorboard_probe import edge_cases
        edge_cases(output)
        return
    elif product == "wandb-extra":
        from wandb_probe import edge_cases
        edge_cases(output)
        return
    elif product == "tensorboard-crash":
        from tensorboard_probe import crash_writer
        crash_writer(output)
        return
    else:
        raise ValueError(product)
    run(output)


def observe_live(root, product, env, crash=False, burst=False, native=False, fast=False):
    from inspect_records import wandb_file, tensorboard_file
    import psutil
    directory = root / (product + ("-burst" if burst else "") + ("-native" if native else "") + ("-fast" if fast else "") + ("-crash" if crash else "-live"))
    directory.mkdir()
    product_worker = product + ("-burst" if burst else "") + ("-native" if native else "") + ("-fast" if fast else "") + ("-crash" if crash else "-live")
    timeline = []
    children = {}
    started = time.monotonic()
    with (directory / "writer.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--worker", product_worker, "--output", str(directory)],
                                   env=env, cwd=directory, stdout=log, stderr=subprocess.STDOUT)
        try:
            ready = wait_for(lambda: (directory / "writer-ready.json").exists() or process.poll() is not None)
            if not ready or not (directory / "writer-ready.json").exists():
                return {"error": "Writer failed before readiness", "exitCode": process.poll()}
            if process.poll() is None:
                try:
                    for child in psutil.Process(process.pid).children(recursive=True):
                        children[child.pid] = child.create_time()
                except psutil.NoSuchProcess:
                    pass
            def sample(phase):
                values, sizes, errors = [], [], []
                files = list(directory.rglob("*.wandb")) if product == "wandb" else list(directory.rglob("*tfevents*"))
                for file in files:
                    if not file.is_file():
                        continue
                    value = wandb_file(file) if product == "wandb" else tensorboard_file(file)
                    sizes.append(value["bytes"])
                    if value["readError"]:
                        errors.append(value["readError"])
                    if product == "wandb":
                        values.extend(row["live/value"] for row in value["history"] if "live/value" in row)
                    else:
                        values.extend(item["value"] for event in value["events"] for item in event.get("values", []) if item["tag"] in ["live/value", "crash/flushed", "crash/unflushed"])
                timeline.append({"phase": phase, "elapsedMs": round((time.monotonic() - started) * 1000),
                                 "writerAlive": process.poll() is None, "finishStarted": (directory / "writer-finishing.json").exists(),
                                 "bytes": sizes, "values": values, "errors": errors})
                return values
            if crash and product == "tensorboard":
                process.wait(timeout=10)
                sample("after-crash")
            else:
                first = wait_for(lambda: 1.0 in sample("before-advance"), timeout=18)
                (directory / "advance").touch()
                if crash:
                    process.wait(timeout=15)
                    time.sleep(.5)
                    sample("after-crash")
                else:
                    second = wait_for(lambda: 2.0 in sample("after-advance-before-finish"), timeout=18)
                    (directory / "finish").touch()
                    process.wait(timeout=25)
                    sample("after-finish")
            result = {"exitCode": process.returncode, "timeline": timeline,
                      "readableBeforeFinish": any(row["writerAlive"] and not row["finishStarted"] and row["values"] for row in timeline),
                      "grewBeforeFinish": any(row["writerAlive"] and not row["finishStarted"] and 1.0 in row["values"] and 2.0 in row["values"] for row in timeline)}
        except Exception as error:
            result = {"error": str(error), "timeline": timeline}
        finally:
            (directory / "advance").touch()
            (directory / "finish").touch()
            if process.poll() is None:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for pid, creation in children.items():
                try:
                    child = psutil.Process(pid)
                    if abs(child.create_time() - creation) < .01 and child.is_running():
                        child.wait(timeout=3)
                except psutil.TimeoutExpired:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except psutil.TimeoutExpired:
                        child.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
    write_json(directory / "observations.json", result)
    return result


def partial_records(root):
    from inspect_records import wandb_file, tensorboard_file
    from tensorboard.backend.event_processing.event_file_loader import RawEventFileLoader
    from tensorboard.compat.proto.event_pb2 import Event
    directory = root / "partial-files"
    directory.mkdir()
    results = {}
    wb = next(root.glob("wandb/wandb/offline-run-*rich-run/*.wandb"))
    original = wb.read_bytes()
    partial = directory / "partial.wandb"
    # The rich run has a 70KB config, so a cut here also tests fragmented records.
    for name, cut in [("inside-large-record", 10000), ("last-record", len(original) - 5)]:
        partial.write_bytes(original[:cut])
        before = wandb_file(partial)
        with partial.open("ab") as stream:
            stream.write(original[cut:])
        after = wandb_file(partial)
        results["wandb-" + name] = {"cut": cut, "partial": before, "completed": after}
    tb = next(root.glob("tensorboard/native/*tfevents*"))
    original = tb.read_bytes()
    partial = directory / "events.out.tfevents.partial"
    partial.write_bytes(original[:-5])
    loader = RawEventFileLoader(str(partial))
    first = [Event.FromString(raw) for raw in loader.Load()]
    with partial.open("ab") as stream:
        stream.write(original[-5:])
    appended = [Event.FromString(raw) for raw in loader.Load()]
    complete = tensorboard_file(tb)
    results["tensorboard-tail-resume"] = {"beforeCount": len(first), "appendedCount": len(appended),
        "totalCount": len(complete["events"]), "noLostOrDuplicatedEvents": len(first) + len(appended) == len(complete["events"])}
    write_json(directory / "observations.json", results)
    return {"tensorboardTailResume": results["tensorboard-tail-resume"],
            "wandbPartialErrors": {key: value["partial"]["readError"] for key, value in results.items() if key.startswith("wandb-")}}


def compare_current(root, env):
    samples = [("wandb", next(root.glob("wandb/wandb/offline-run-*rich-run/*.wandb")))]
    for extra in [root / "wandb-extra-complete", root / "wandb-extra-verified", root / "wandb-extra", root / "follow-up/wandb-extra"]:
        files = list(extra.rglob("*.wandb"))
        if files:
            samples.append(("wandb", files[0]))
            break
    samples += [("tensorboard", file) for part in ["tensorboard", "tensorboard-extra"] for file in sorted((root / part).rglob("*tfevents*")) if file.is_file()]
    directory = root / "current-topolumia-reader"
    directory.mkdir(exist_ok=True)
    result = []
    for index, (provider, file) in enumerate(samples):
        process = subprocess.run([sys.executable, str(REPO / "scripts/runtime/experiment-record-parser.py"), "--provider", provider,
                                  "--file", str(file), "--label", file.parent.name], env=env, cwd=root, capture_output=True, timeout=30)
        (directory / f"{index:02d}.json").write_bytes(process.stdout)
        (directory / f"{index:02d}.stderr.txt").write_bytes(process.stderr)
        summary = {"provider": provider, "file": file.relative_to(root).as_posix(), "exitCode": process.returncode}
        if process.returncode == 0:
            parsed = json.loads(process.stdout)
            summary["runs"] = [{"sourceId": run["sourceId"], "status": run["status"], "series": [{"key": line["key"], "xKey": line.get("xKey"), "pointCount": len(line["points"])} for line in run["series"]]} for run in parsed["runs"]]
        else:
            summary["error"] = process.stderr.decode("utf-8", "replace")[-2000:]
        result.append(summary)
    write_json(directory / "summary.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--worker")
    parser.add_argument("--supplement", action="store_true", help="Add committed/low-latency W&B and MLflow follow-ups to an existing research output")
    parser.add_argument("--inspect-only", action="store_true", help="Refresh decoded records, current-reader comparison and file hashes without running writers")
    args = parser.parse_args()
    root = Path(args.output).resolve()
    if args.worker:
        for stream in [sys.stdout, sys.stderr]:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")
        env = isolated_env(root / "sdk-state")
        for key in list(os.environ):
            if key.startswith(("WANDB_", "MLFLOW_")):
                del os.environ[key]
        os.environ.update(env)
        worker(args.worker, root)
        return
    if args.inspect_only:
        from inspect_records import inspect_all
        result = inspect_all(root)
        compare_current(root, isolated_env(root / "sdk-state"))
        write_json(root / "inspection-summary.json", result)
        inventory(root, root / "file-manifest.json")
        print(json.dumps(result), flush=True)
        return
    if args.supplement:
        directory = root / "follow-up"
        directory.mkdir(exist_ok=False)
        env = isolated_env(root / "sdk-state")
        report = {}
        for fast in [False, True]:
            report["wandb-fast" if fast else "wandb-committed-default"] = observe_live(directory, "wandb", env, fast=fast)
        target = directory / "mlflow"
        target.mkdir()
        with (target / "writer.log").open("w", encoding="utf-8") as log:
            process = subprocess.run([sys.executable, str(SCRIPT), "--worker", "mlflow", "--output", str(target)], cwd=target, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        report["mlflowExitCode"] = process.returncode
        target = directory / "wandb-extra"
        target.mkdir()
        with (target / "writer.log").open("w", encoding="utf-8") as log:
            process = subprocess.run([sys.executable, str(SCRIPT), "--worker", "wandb-extra", "--output", str(target)], cwd=target, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        report["wandbExtraExitCode"] = process.returncode
        from inspect_records import inspect_all
        report["inspection"] = inspect_all(root)
        write_json(directory / "summary.json", report)
        inventory(root, root / "file-manifest.json")
        print("Supplement complete", flush=True)
        return
    if root.exists() and any(root.iterdir()):
        raise SystemExit("Use a new empty output directory; previous research data is preserved.")
    root.mkdir(parents=True, exist_ok=True)
    env = isolated_env(root / "sdk-state")
    write_json(root / "environment.json", {"python": sys.version, "packages": versions(), "cloudAccountsUsed": False})
    report = {"writers": {}, "live": {}, "crash": {}}
    for product in ["wandb", "tensorboard", "mlflow"]:
        directory = root / product
        directory.mkdir()
        with (directory / "writer.log").open("w", encoding="utf-8") as log:
            process = subprocess.run([sys.executable, str(SCRIPT), "--worker", product, "--output", str(directory)],
                                     cwd=directory, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        report["writers"][product] = {"exitCode": process.returncode}
        write_json(root / "research-summary.json", report)
        print(product, "writer exit", process.returncode, flush=True)
    for product in ["wandb", "tensorboard"]:
        report["live"][product] = observe_live(root, product, env)
        write_json(root / "research-summary.json", report)
        print(product, "live observed", flush=True)
        report["crash"][product] = observe_live(root, product, env, crash=True)
        write_json(root / "research-summary.json", report)
    report["live"]["wandb-burst"] = observe_live(root, "wandb", env, burst=True)
    report["live"]["wandb-fast"] = observe_live(root, "wandb", env, fast=True)
    report["live"]["tensorboard-native"] = observe_live(root, "tensorboard", env, native=True)
    worker("tensorboard-extra", root / "tensorboard-extra")
    target = root / "wandb-extra"
    target.mkdir()
    with (target / "writer.log").open("w", encoding="utf-8") as log:
        process = subprocess.run([sys.executable, str(SCRIPT), "--worker", "wandb-extra", "--output", str(target)], cwd=target, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    report["writers"]["wandb-extra"] = {"exitCode": process.returncode}
    from inspect_records import inspect_all
    report["inspection"] = inspect_all(root)
    report["partialRecords"] = partial_records(root)
    report["currentReader"] = compare_current(root, env)
    write_json(root / "research-summary.json", report)
    inventory(root, root / "file-manifest.json")
    print(json.dumps({"writers": report["writers"], "inspection": report["inspection"]}), flush=True)


if __name__ == "__main__":
    main()
