"""Exercise TensorBoardX and protobuf Event writers, including plugin sidecars."""
from __future__ import annotations

import os
import time
from pathlib import Path

from common import Probe, write_json


def run(root):
    import numpy as np
    from tensorboardX import SummaryWriter
    from tensorboard.compat.proto import event_pb2, graph_pb2, node_def_pb2, summary_pb2, config_pb2
    from tensorboard.summary.writer.event_file_writer import EventFileWriter

    probe = Probe(root, "tensorboard")
    rng = np.random.default_rng(23)
    writer = SummaryWriter(logdir=str(probe.root / "rich"), max_queue=1, flush_secs=1)
    probe.case("legacy-scalar", lambda: writer.add_scalar("train/loss", np.float32(.8), 10, walltime=1700000000.0))
    probe.case("same-step-different-values", lambda: (writer.add_scalar("edge/duplicate", 1.0, 10), writer.add_scalar("edge/duplicate", 2.0, 10)))
    probe.case("out-of-order-and-negative-step", lambda: (writer.add_scalar("edge/reset", .9, 100), writer.add_scalar("edge/reset", .8, 2), writer.add_scalar("edge/reset", .7, -1)))
    probe.case("nonfinite-values", lambda: (writer.add_scalar("edge/nan", float("nan"), 0), writer.add_scalar("edge/inf", float("inf"), 0)))
    probe.case("tag-unicode-and-special", lambda: writer.add_scalar("中文/score.with spaces", .75, 3))
    probe.case("add-scalars-subdirectories", lambda: writer.add_scalars("compare/loss", {"train": .8, "eval": .9}, 10))
    probe.case("histogram", lambda: writer.add_histogram("weights/histogram", rng.normal(size=100), 10, bins=8))
    probe.case("histogram-raw-buckets", lambda: writer.add_histogram_raw("weights/raw", min=-1, max=1, num=3, sum=0, sum_squares=2,
        bucket_limits=[-1, 0, 1], bucket_counts=[1, 1, 1], global_step=10))
    image = np.zeros((3, 24, 24), dtype=np.uint8)
    image[0] = 210
    probe.case("image-chw", lambda: writer.add_image("media/image", image, 10, dataformats="CHW"))
    probe.case("images-batch", lambda: writer.add_images("media/images", np.stack([image, image[:, ::-1]]), 10, dataformats="NCHW"))
    audio = np.sin(2 * np.pi * 440 * np.arange(8000) / 8000).astype(np.float32)[:, None] * .1
    probe.case("audio", lambda: writer.add_audio("media/audio", audio, 10, sample_rate=8000))
    probe.case("video", lambda: writer.add_video("media/video", np.zeros((1, 3, 3, 16, 16), dtype=np.uint8), 10, fps=3))
    probe.case("text-markdown", lambda: writer.add_text("notes/markdown", "**Synthetic** result\n\n| a | b |\n|---|---|\n| 1 | 2 |", 10))
    probe.case("precision-recall-curve", lambda: writer.add_pr_curve("eval/pr", np.array([0, 1, 1, 0]), np.array([.1, .8, .7, .3]), 10, num_thresholds=7))
    probe.case("custom-scalars-layout", lambda: writer.add_custom_scalars({"train": {"loss": ["Multiline", ["train/loss", "edge/duplicate"]]}}))
    probe.case("embedding-projector-sidecars", lambda: writer.add_embedding(rng.normal(size=(4, 3)).astype(np.float32),
        metadata=[["a", "cat"], ["b", "dog"], ["c", "cat"], ["d", "dog"]], metadata_header=["id", "class"],
        label_img=np.zeros((4, 3, 8, 8), dtype=np.float32), global_step=10, tag="embedding/features"))
    probe.case("hparams-session-and-metrics", lambda: writer.add_hparams({"lr": .001, "batch": 16, "optimizer": "adam", "enabled": True}, {"hparam/score": .8}, name="trial-a"))
    probe.case("mesh", lambda: writer.add_mesh("media/mesh", vertices=np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]], dtype=np.float32),
        colors=np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255]]], dtype=np.float32), faces=np.array([[[0, 1, 2]]]), global_step=10))
    writer.flush()
    writer.close()

    native = EventFileWriter(str(probe.root / "native"), max_queue_size=1, flush_secs=1)
    def tensor_scalars():
        from tensorboard.util import tensor_util
        metadata = summary_pb2.SummaryMetadata(plugin_data=summary_pb2.SummaryMetadata.PluginData(plugin_name="scalars"), display_name="Double scalar")
        native.add_event(event_pb2.Event(wall_time=1700000001.0, step=10, summary=summary_pb2.Summary(value=[
            summary_pb2.Summary.Value(tag="precision/double", tensor=tensor_util.make_tensor_proto(np.float64(.123456789012345)), metadata=metadata),
            summary_pb2.Summary.Value(tag="precision/int64", tensor=tensor_util.make_tensor_proto(np.int64(2 ** 54 + 1)), metadata=metadata),
            summary_pb2.Summary.Value(tag="tensor/vector", tensor=tensor_util.make_tensor_proto(np.array([1, 2, 3], dtype=np.int32)),
                metadata=summary_pb2.SummaryMetadata(plugin_data=summary_pb2.SummaryMetadata.PluginData(plugin_name="synthetic_custom"))),
            summary_pb2.Summary.Value(tag="tensor/string", tensor=tensor_util.make_tensor_proto([b"synthetic"])),
        ])))
    probe.case("tensor-scalars-dtype-and-custom-plugin", tensor_scalars)
    def graph():
        value = graph_pb2.GraphDef(node=[node_def_pb2.NodeDef(name="input", op="Placeholder"), node_def_pb2.NodeDef(name="output", op="Identity", input=["input"])])
        native.add_event(event_pb2.Event(wall_time=1700000002, graph_def=value.SerializeToString()))
        native.add_event(event_pb2.Event(wall_time=1700000002, tagged_run_metadata=event_pb2.TaggedRunMetadata(tag="step10", run_metadata=config_pb2.RunMetadata().SerializeToString())))
    probe.case("graph-and-run-metadata-protobuf", graph)
    probe.case("log-message-and-session-status", lambda: (
        native.add_event(event_pb2.Event(wall_time=1700000003, log_message=event_pb2.LogMessage(level=20, message="Synthetic training message"))),
        native.add_event(event_pb2.Event(step=0, session_log=event_pb2.SessionLog(status=event_pb2.SessionLog.START, checkpoint_path="synthetic.ckpt")))))
    native.flush()
    native.close()

    restart = probe.root / "restart"
    first = SummaryWriter(logdir=str(restart))
    for step in [0, 1, 2, 3]:
        first.add_scalar("restart/loss", 10 - step, step)
    first.close()
    def restart_writer():
        second = SummaryWriter(logdir=str(restart), purge_step=2)
        second.add_scalar("restart/loss", 20.0, 2)
        second.add_scalar("restart/loss", 19.0, 3)
        second.close()
    probe.case("restart-same-logdir-purge-step", restart_writer)
    probe.save()


def live_writer(root, native=False):
    root = Path(root)
    if native:
        from tensorboard.summary.writer.event_file_writer import EventFileWriter
        from tensorboard.compat.proto.event_pb2 import Event
        from tensorboard.compat.proto.summary_pb2 import Summary
        writer = EventFileWriter(str(root / "logs"), max_queue_size=100, flush_secs=120)
        emit = lambda value, step: writer.add_event(Event(step=step, wall_time=time.time(), summary=Summary(value=[Summary.Value(tag="live/value", simple_value=value)])))
    else:
        from tensorboardX import SummaryWriter
        writer = SummaryWriter(logdir=str(root / "logs"), max_queue=100, flush_secs=1)
        emit = lambda value, step: writer.add_scalar("live/value", value, step)
    emit(1.0, 0)
    writer.flush()
    write_json(root / "writer-ready.json", {"pid": os.getpid(), "finished": False})
    deadline = time.monotonic() + 120
    while not (root / "advance").exists() and time.monotonic() < deadline:
        time.sleep(.1)
    emit(2.0, 1)
    writer.flush()
    write_json(root / "writer-advanced.json", {"pid": os.getpid(), "finished": False})
    deadline = time.monotonic() + 120
    while not (root / "finish").exists() and time.monotonic() < deadline:
        time.sleep(.1)
    write_json(root / "writer-finishing.json", {"pid": os.getpid()})
    writer.close()
    write_json(root / "writer-finished.json", {"finished": True})


def crash_writer(root):
    from tensorboardX import SummaryWriter
    writer = SummaryWriter(logdir=str(Path(root) / "logs"), max_queue=100, flush_secs=120)
    writer.add_scalar("crash/flushed", 1.0, 0)
    writer.flush()
    write_json(Path(root) / "writer-ready.json", {"pid": os.getpid()})
    writer.add_scalar("crash/unflushed", 2.0, 1)
    os._exit(7)


def edge_cases(root):
    from tensorboardX import SummaryWriter
    from tensorboard.summary.writer.event_file_writer import EventFileWriter
    from tensorboard.compat.proto.event_pb2 import Event, SessionLog
    from tensorboard.compat.proto.summary_pb2 import Summary
    probe = Probe(root, "tensorboard-writer-edges")
    def overwrite():
        directory = probe.root / "rapid-reopen"
        first = SummaryWriter(logdir=str(directory))
        first.add_scalar("first", 1.0, 0)
        first.close()
        first_files = {file.name: file.read_bytes() for file in directory.glob("*tfevents*")}
        second = SummaryWriter(logdir=str(directory))
        second.add_scalar("second", 2.0, 1)
        second.close()
        second_files = {file.name: file.read_bytes() for file in directory.glob("*tfevents*")}
        return {"before": list(first_files), "after": list(second_files), "overwritten": [name for name, data in first_files.items() if name in second_files and second_files[name] != data]}
    probe.case("tensorboardx-rapid-reopen-file-identity", overwrite)
    def official_restart():
        directory = probe.root / "native-restart"
        def emit(writer, step, value):
            writer.add_event(Event(step=step, wall_time=time.time(), summary=Summary(value=[Summary.Value(tag="restart/loss", simple_value=value)])))
        first = EventFileWriter(str(directory))
        for step in [0, 1, 2, 3]:
            emit(first, step, 10.0 - step)
        first.close()
        second = EventFileWriter(str(directory))
        second.add_event(Event(step=2, wall_time=time.time(), session_log=SessionLog(status=SessionLog.START)))
        emit(second, 2, 20.0)
        emit(second, 3, 19.0)
        second.close()
        return {"files": [file.name for file in directory.glob("*tfevents*")]}
    probe.case("official-writer-restart-and-session-purge", official_restart)
    def concurrent():
        directory = probe.root / "native-concurrent"
        first, second = EventFileWriter(str(directory)), EventFileWriter(str(directory))
        first.add_event(Event(step=0, summary=Summary(value=[Summary.Value(tag="shared/loss", simple_value=1.0)])))
        second.add_event(Event(step=0, summary=Summary(value=[Summary.Value(tag="shared/loss", simple_value=2.0)])))
        first.close()
        second.close()
        return {"files": [file.name for file in directory.glob("*tfevents*")]}
    probe.case("official-writers-concurrent-same-directory", concurrent)
