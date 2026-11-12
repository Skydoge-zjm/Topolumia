"""Exercise actual W&B offline writers; API success is checked against files later."""
from __future__ import annotations

import os
import time
from pathlib import Path

from common import Probe, write_json


def settings():
    import wandb
    return wandb.Settings(console="off", disable_git=True)


def run(root):
    import numpy as np
    import pandas as pd
    import wandb
    from PIL import Image

    probe = Probe(root, "wandb")
    source = probe.root / "synthetic-source"
    source.mkdir(exist_ok=True)
    (source / "train.py").write_text("# Synthetic research fixture\nrank = 4\n", encoding="utf-8")
    (source / "config.yaml").write_text("rank: 4\nbatch_size: 16\n", encoding="utf-8")
    (source / "checkpoint.bin").write_bytes(bytes(range(256)) * 4)
    image = np.zeros((32, 32, 3), dtype=np.uint8)
    image[..., 0] = np.arange(32, dtype=np.uint8)[:, None] * 7
    image[..., 1] = 150
    Image.fromarray(image).save(source / "source.png")
    rng = np.random.default_rng(17)
    audio = np.sin(2 * np.pi * 440 * np.arange(8000) / 8000).astype(np.float32) * .1
    run = wandb.init(project="topolumia-ecosystem-research", id="rich-run", name="Synthetic rich run",
                     group="rank-4", job_type="train", tags=["synthetic", "unicode-中文"],
                     notes="Offline SDK behaviour, no cloud account", dir=str(probe.root), mode="offline",
                     config={"rank": 4, "optimizer": {"lr": .001, "betas": [.9, .99]}, "seed": 17, "fragmented": "x" * 70000}, settings=settings())
    write_json(probe.root / "run-locator.json", {"id": run.id, "dir": run.dir, "path": run.path})
    probe.case("config-update", lambda: run.config.update({"rank": 8, "batch_size": 16}, allow_val_change=True))
    probe.case("custom-axis-and-summary-definitions", lambda: (
        run.define_metric("epoch"), run.define_metric("val/*", step_metric="epoch", step_sync=True),
        run.define_metric("train/loss", summary="min"), run.define_metric("score", summary="max"),
        run.define_metric("hidden/internal", hidden=True), run.define_metric("nostep", step_metric="epoch", step_sync=False)))
    probe.case("commit-false-and-merged-history", lambda: (
        run.log({"train/loss": 1.0, "epoch": .5}, step=0, commit=False),
        run.log({"val/psnr": 20.0, "score": .7}, step=0, commit=True)))
    probe.case("nested-keys-and-numpy-scalars", lambda: run.log({"nested": {"loss": np.float32(.8)}, "flat/dotted.metric": 2.0,
        "中文/准确率": .75, "bool/flag": True, "text/numeric": "1.25", "null/missing": None, "integer/large": 2 ** 54 + 1,
        "epoch": 1.5, "val/psnr": 22.0}, step=1))
    probe.case("nonfinite-values", lambda: run.log({"nonfinite/nan": float("nan"), "nonfinite/inf": float("inf"),
        "nonfinite/negative_inf": -float("inf"), "train/loss": .7}, step=2))
    probe.case("summary-final-and-nested", lambda: run.summary.update({"final/score": .8123456789012345,
        "evaluation": {"psnr": 25.0, "n": 3}, "final/status": "succeeded"}))
    probe.case("image-basic-and-list", lambda: run.log({"media/image": wandb.Image(image, caption="synthetic 中文"),
        "media/images": [wandb.Image(image), wandb.Image(image[:, ::-1])]}, step=3))
    probe.case("image-mask-and-boxes", lambda: run.log({"media/annotated": wandb.Image(image,
        masks={"truth": {"mask_data": (np.indices((32, 32))[0] > 16).astype(np.uint8), "class_labels": {0: "background", 1: "object"}}},
        boxes={"predictions": {"box_data": [{"position": {"minX": .1, "minY": .1, "maxX": .8, "maxY": .8},
            "class_id": 1, "box_caption": "synthetic", "scores": {"confidence": .9}}], "class_labels": {1: "object"}}})}, step=4))
    probe.case("audio-waveform", lambda: run.log({"media/audio": wandb.Audio(audio, sample_rate=8000, caption="440Hz synthetic")}, step=5))
    gif = source / "tiny.gif"
    Image.fromarray(image).save(gif, save_all=True, append_images=[Image.fromarray(image[:, ::-1])], duration=100, loop=0)
    probe.case("video-file", lambda: run.log({"media/video": wandb.Video(str(gif), caption="synthetic video", format="gif")}, step=6))
    probe.case("histogram-distribution", lambda: run.log({"distribution/weights": wandb.Histogram(rng.normal(size=100), num_bins=8)}, step=7))
    table = wandb.Table(columns=["sample", "score", "preview"], data=[["a", .8, wandb.Image(image)], ["b", None, wandb.Image(image)]], optional=True)
    probe.case("table-with-media-and-null", lambda: run.log({"table/eval": table}, step=8))
    probe.case("table-dataframe", lambda: run.log({"table/dataframe": wandb.Table(dataframe=pd.DataFrame({"name": ["x", "y"], "metric": [.2, .4]}))}, step=9))
    probe.case("table-mutable-log", lambda: run.log({"table/mutable": wandb.Table(columns=["i", "value"], data=[[0, 1]], log_mode="MUTABLE")}, step=10))
    incremental = None
    def incremental_table():
        nonlocal incremental
        incremental = wandb.Table(columns=["i", "value"], log_mode="INCREMENTAL")
        incremental.add_data(0, .1)
        run.log({"table/incremental": incremental}, step=11)
        incremental.add_data(1, .2)
        run.log({"table/incremental": incremental}, step=12)
    probe.case("table-incremental-two-logs", incremental_table)
    def plots():
        run.log({"plot/line": wandb.plot.line(wandb.Table(data=[[0, 1], [1, .5]], columns=["step", "loss"]), "step", "loss", title="Synthetic line")}, step=13)
    probe.case("custom-chart-vega-table", plots)
    probe.case("html-panel", lambda: run.log({"media/html": wandb.Html("<html><b>synthetic result</b></html>")}, step=14))
    probe.case("object3d-point-cloud", lambda: run.log({"media/pointcloud": wandb.Object3D(rng.normal(size=(8, 3)))}, step=15))
    def matplotlib_plot():
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots()
        ax.plot([0, 1], [1, .5])
        run.log({"plot/matplotlib": wandb.Image(fig)}, step=16)
        plt.close(fig)
    probe.case("matplotlib-image", matplotlib_plot)
    def plotly_plot():
        import plotly.graph_objects as go
        run.log({"plot/plotly": wandb.Plotly(go.Figure(data=go.Scatter(x=[0, 1], y=[1, .5])))}, step=17)
    probe.case("plotly-interactive", plotly_plot)
    def artifact():
        value = wandb.Artifact("synthetic-checkpoint", type="model", metadata={"epoch": 1, "rank": 8})
        value.add_file(str(source / "checkpoint.bin"))
        value.add_file(str(source / "config.yaml"))
        value.add_reference((source / "source.png").as_uri(), name="external-image", checksum=False)
        run.log_artifact(value, aliases=["latest", "best"])
    probe.case("artifact-files-metadata-reference-aliases", artifact)
    probe.case("save-file", lambda: run.save(str(source / "checkpoint.bin"), base_path=str(source), policy="now"))
    probe.case("log-code", lambda: run.log_code(root=str(source)))
    probe.case("same-step-default-commit-merge", lambda: run.log({"edge/duplicate_step": 99.0}, step=17))
    probe.case("backward-step-after-commit", lambda: run.log({"edge/backward_step": 88.0}, step=2))
    probe.case("negative-step", lambda: run.log({"edge/negative_step": 77.0}, step=-1))
    probe.case("last-step", lambda: run.log({"train/loss": .123, "epoch": 2.5, "val/psnr": 24.0}, step=18))
    probe.case("finish-success", lambda: run.finish(exit_code=0))
    for state, exit_code in [("failed-with-metrics", 7), ("failed-before-first-metric", 1)]:
        def failed_run(state=state, exit_code=exit_code):
            current = wandb.init(project="topolumia-ecosystem-research", id=state, name=state, dir=str(probe.root), mode="offline", settings=settings())
            if "with-metrics" in state:
                current.log({"loss": 2.0})
            current.finish(exit_code=exit_code)
        probe.case(state, failed_run)
    def same_id_resume():
        current = wandb.init(project="topolumia-ecosystem-research", id="rich-run", resume="must", dir=str(probe.root), mode="offline", settings=settings())
        current.log({"resume/loss": .4}, step=0)
        current.finish()
    probe.case("offline-resume-must-same-id", same_id_resume)
    def concurrent_runs():
        first = wandb.init(project="topolumia-ecosystem-research", id="concurrent-a", dir=str(probe.root), mode="offline", reinit="create_new", settings=settings())
        second = wandb.init(project="topolumia-ecosystem-research", id="concurrent-b", dir=str(probe.root), mode="offline", reinit="create_new", settings=settings())
        first.log({"loss": 1.0})
        second.log({"loss": 2.0})
        first.finish()
        second.finish()
    probe.case("two-active-runs", concurrent_runs)
    probe.save()


def live_writer(root, crash=False, burst=False, flush_interval=None):
    import wandb
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    configured = settings()
    if flush_interval is not None:
        configured.x_transaction_log_flush_interval = flush_interval
    current = wandb.init(project="topolumia-ecosystem-research", id="live-run", dir=str(root), mode="offline", settings=configured)
    current.log({"live/value": 1.0}, step=0, commit=True)
    if burst:
        for step in range(1, 9):
            current.log({"padding/text": "x" * 12000}, step=step)
    write_json(root / "writer-ready.json", {"pid": os.getpid(), "dir": current.dir, "finished": False})
    deadline = time.monotonic() + 120
    while not (root / "advance").exists() and time.monotonic() < deadline:
        time.sleep(.1)
    current.log({"live/value": 2.0}, step=9 if burst else 1, commit=True)
    if burst:
        for step in range(10, 18):
            current.log({"padding/text": "y" * 12000}, step=step)
    if crash:
        os._exit(7)
    write_json(root / "writer-advanced.json", {"pid": os.getpid(), "finished": False})
    deadline = time.monotonic() + 120
    while not (root / "finish").exists() and time.monotonic() < deadline:
        time.sleep(.1)
    write_json(root / "writer-finishing.json", {"pid": os.getpid()})
    current.finish()
    write_json(root / "writer-finished.json", {"pid": os.getpid(), "finished": True})


def edge_cases(root):
    import sys
    import numpy as np
    import wandb
    probe = Probe(root, "wandb-extra")
    current = wandb.init(project="topolumia-ecosystem-research", id="extra-run", dir=str(probe.root), mode="offline",
                         settings=wandb.Settings(console="wrap", disable_git=True, x_transaction_log_flush_interval=1))
    probe.case("console-stdout-stderr-progress", lambda: (print("Synthetic stdout 中文", flush=True), print("Synthetic stderr", file=sys.stderr, flush=True), print("progress 1\rprogress 2", flush=True)))
    probe.case("scalar-vectors-and-nested-paths", lambda: current.log({"a/b": 1.0, "a": {"b": 2.0}, "vector/list": [1.0, 2.0], "vector/numpy": np.array([1., 2.]), "_user_metric": .5}))
    def mutable():
        table = wandb.Table(columns=["id", "score"], data=[["a", .1]], log_mode="MUTABLE")
        current.log({"table/mutable": table})
        table.add_data("b", .2)
        current.log({"table/mutable": table})
    probe.case("mutable-table-version-update", mutable)
    def joined():
        left = wandb.Table(columns=["id", "x"], data=[["a", 1], ["b", 2]])
        right = wandb.Table(columns=["id", "y"], data=[["a", .8], ["b", .9]])
        current.log({"table/joined": wandb.JoinedTable(left, right, "id")})
    probe.case("joined-table", joined)
    probe.case("partitioned-table-top-level-export", lambda: getattr(wandb, "PartitionedTable"), expected_error=True)
    def partitioned():
        from wandb.data_types import PartitionedTable
        artifact = wandb.Artifact("synthetic-partitioned", type="dataset")
        artifact.add(wandb.Table(columns=["x"], data=[[1], [2]]), "parts/part-0")
        artifact.add(PartitionedTable(parts_path="parts"), "combined")
        current.log_artifact(artifact)
    probe.case("partitioned-table-artifact", partitioned)
    def unsupported_molecule():
        file = probe.root / "unsupported.xyz"
        file.write_text("2\nsynthetic hydrogen\nH 0 0 0\nH 0 0 0.74\n", encoding="utf-8")
        return wandb.Molecule(str(file))
    probe.case("molecule-unsupported-extension", unsupported_molecule, expected_error=True)
    def molecule():
        file = probe.root / "molecule.pdb"
        file.write_text("ATOM      1  H1  SYN A   1       0.000   0.000   0.000  1.00  0.00           H\nATOM      2  H2  SYN A   1       0.000   0.000   0.740  1.00  0.00           H\nEND\n", encoding="utf-8")
        current.log({"media/molecule": wandb.Molecule(str(file))})
    probe.case("molecule-file", molecule)
    def summary_delete():
        current.summary["temporary"] = 1
        del current.summary["temporary"]
        current.summary["final"] = {"score": .9}
    probe.case("summary-update-and-delete", summary_delete)
    probe.case("explicit-commit-and-same-step-drop", lambda: (
        current.log({"edge/partial_a": 1.0}, step=10, commit=False),
        current.log({"edge/partial_b": 2.0}, step=10, commit=True),
        current.log({"edge/dropped_same_step": 99.0}, step=10, commit=True),
        current.log({"edge/dropped_backward_step": 88.0}, step=2, commit=True)))
    current.finish()
