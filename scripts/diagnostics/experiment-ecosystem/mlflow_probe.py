"""Use MLflow's real local SQLite/artifact stores, with no tracking account."""
from __future__ import annotations

from common import Probe, write_json


def entity(value):
    from google.protobuf.json_format import MessageToDict
    return MessageToDict(value.to_proto(), preserving_proto_field_name=True)


def run(root):
    import mlflow
    import numpy as np
    import pandas as pd
    from mlflow import MlflowClient
    from mlflow.entities import Metric
    from PIL import Image

    probe = Probe(root, "mlflow")
    mlflow.set_tracking_uri("sqlite:///" + (probe.root / "tracking.sqlite").as_posix())
    client = MlflowClient()
    experiment = client.create_experiment("Synthetic ecosystem research", artifact_location=(probe.root / "artifacts").as_uri())
    mlflow.set_experiment(experiment_id=experiment)
    run_ids = []
    with mlflow.start_run(run_name="parent", tags={"synthetic": "true", "中文": "标签"}) as active:
        run_ids.append(active.info.run_id)
        probe.case("nested-params-and-tags", lambda: (mlflow.log_params({"lr": .001, "rank": 4, "optimizer": {"name": "adam"}}), mlflow.set_tags({"stage": "train", "description": "synthetic"})))
        probe.case("parameter-immutability", lambda: mlflow.log_param("rank", 8), expected_error=True)
        probe.case("metrics-duplicate-and-reset-steps", lambda: (
            mlflow.log_metric("train/loss", 1.0, step=10), mlflow.log_metric("train/loss", .8, step=10),
            mlflow.log_metric("train/loss", .9, step=2), mlflow.log_metric("train/loss", 1.1, step=-1)))
        probe.case("nonfinite-metrics", lambda: (mlflow.log_metric("edge/nan", float("nan"), step=0), mlflow.log_metric("edge/inf", float("inf"), step=0)))
        probe.case("metric-timestamp-and-batch", lambda: client.log_batch(active.info.run_id, metrics=[Metric("eval/score", .8, 1700000000000, 1), Metric("eval/score", .9, 1700000001000, 2)]))
        probe.case("metric-async", lambda: mlflow.log_metric("async/loss", .3, step=3, synchronous=False).wait())
        probe.case("text-and-json-artifacts", lambda: (mlflow.log_text("# Synthetic report\nA result", "notes/report.md"), mlflow.log_dict({"rank": 4, "nested": {"lr": .001}}, "config/config.json")))
        image = np.zeros((24, 24, 3), dtype=np.uint8)
        image[..., 1] = 180
        probe.case("image-artifact", lambda: mlflow.log_image(Image.fromarray(image), "images/preview.png"))
        probe.case("time-series-image", lambda: mlflow.log_image(image, key="predictions", step=10, timestamp=1700000000000))
        probe.case("table-artifact", lambda: mlflow.log_table(pd.DataFrame({"sample": ["a", "b"], "score": [.8, .9]}), artifact_file="tables/eval.json"))
        def figure():
            import matplotlib.pyplot as plt
            fig, ax = plt.subplots()
            ax.plot([0, 1], [1, .5])
            mlflow.log_figure(fig, "plots/loss.png")
            plt.close(fig)
        probe.case("figure-artifact", figure)
        checkpoint = probe.root / "synthetic-checkpoint.bin"
        checkpoint.write_bytes(bytes(range(128)))
        probe.case("checkpoint-artifact", lambda: mlflow.log_artifact(str(checkpoint), "checkpoints"))
        def dataset():
            frame = pd.DataFrame({"feature": [1, 2], "label": [0, 1]})
            source = probe.root / "dataset.csv"
            frame.to_csv(source, index=False)
            value = mlflow.data.from_pandas(frame, source=source.as_uri(), name="synthetic-data", targets="label")
            mlflow.log_input(value, context="training")
        probe.case("dataset-input-lineage", dataset)
        probe.case("unregistered-dataset-source", lambda: mlflow.data.from_pandas(pd.DataFrame({"x": [1]}), source="synthetic://generated"), expected_error=True)
        def child():
            with mlflow.start_run(run_name="child", nested=True) as nested:
                run_ids.append(nested.info.run_id)
                mlflow.log_metric("child/score", .5)
        probe.case("nested-run", child)
        write_json(probe.root / "visible-while-running.json", {
            "status": client.get_run(active.info.run_id).info.status,
            "history": [entity(metric) for metric in client.get_metric_history(active.info.run_id, "train/loss")],
        })
    parent = run_ids[0]
    def resume():
        with mlflow.start_run(run_id=parent):
            mlflow.log_metric("train/loss", .4, step=20)
    probe.case("resume-finished-run", resume)
    try:
        with mlflow.start_run(run_name="failed") as failed:
            run_ids.append(failed.info.run_id)
            mlflow.log_metric("loss", 5.0)
            raise RuntimeError("Synthetic training failure")
    except RuntimeError:
        pass
    probe.case("failed-lifecycle", lambda: {"status": client.get_run(run_ids[-1]).info.status})
    metadata = []
    for run_id in run_ids:
        current = client.get_run(run_id)
        histories = {}
        for key in current.data.metrics:
            histories[key] = [entity(metric) for metric in client.get_metric_history(run_id, key)]
        metadata.append({"info": entity(current.info), "data": entity(current.data), "inputs": entity(current.inputs), "histories": histories})
    write_json(probe.root / "decoded-runs.json", metadata)
    probe.save()
