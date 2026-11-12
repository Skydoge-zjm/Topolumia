"""Synthetic W&B/TensorBoard training host. No accounts, GPUs or real data."""
from __future__ import annotations
import argparse
import multiprocessing
import os
import time
from pathlib import Path


def wandb_writer(root, steps, interval):
    os.environ["WANDB_MODE"] = "offline"
    os.environ["WANDB_CONFIG_DIR"] = str(root / "wandb-config")
    os.environ["WANDB_CACHE_DIR"] = str(root / "wandb-cache")
    import numpy as np
    import wandb
    for attempt in (1, 2):
        run = wandb.init(project="topolumia-wsl-synthetic", id="attempt-" + str(attempt), name="WSL attempt " + str(attempt), dir=str(root / "wandb"), mode="offline", config={"rank": 4, "batch_size": 32 if attempt == 1 else 16}, settings=wandb.Settings(console="off", disable_git=True, x_stats_sampling_interval=1, x_transaction_log_flush_interval=1))
        # The native SDK's transaction log flush setting controls visible latency.
        run.define_metric("epoch")
        run.define_metric("eval/*", step_metric="epoch")
        (root / "wandb-started").write_text(str(os.getpid()))
        for step in range(steps if attempt == 2 else max(8, steps // 3)):
            run.log({"loss": 1 / (step + 1) + attempt * .01, "epoch": step / 10, "eval/score": step / 100, "learning_rate": .001 / (step + 1)}, commit=True)
            if step == 2:
                run.log({"preview": wandb.Image(np.zeros((16, 16, 3), dtype=np.uint8)), "results": wandb.Table(columns=["sample", "score"], data=[["a", .8], ["b", .9]])})
            time.sleep(interval)
        run.summary["final/score"] = .9
        run.finish(exit_code=1 if attempt == 1 else 0)
    (root / "wandb-done").write_text("done")


def tensorboard_writer(root, steps, interval):
    from tensorboardX import SummaryWriter
    from tensorboard.summary.writer.event_file_writer import EventFileWriter
    from tensorboard.compat.proto.event_pb2 import Event, SessionLog
    directory = root / "tensorboard" / "baseline"
    writer = SummaryWriter(str(directory), flush_secs=1)
    (root / "tensorboard-started").write_text(str(os.getpid()))
    for step in range(steps):
        writer.add_scalar("loss", 1 / (step + 1), step)
        writer.add_scalar("accuracy", step / steps, step)
        writer.flush()
        time.sleep(interval)
    import numpy as np
    writer.add_embedding(np.asarray([[0., 1.], [1., 0.], [1., 1.]], dtype=np.float32), metadata=["a", "b", "c"], global_step=0, tag="sample")
    writer.close()
    # A different writer and a restart marker must preserve all raw observations.
    restart = EventFileWriter(str(directory), filename_suffix=".restart")
    restart.add_event(Event(step=3, wall_time=time.time(), session_log=SessionLog(status=SessionLog.START)))
    from tensorboard.compat.proto.summary_pb2 import Summary
    for step in (3, 3, 2):
        restart.add_event(Event(step=step, wall_time=time.time(), summary=Summary(value=[Summary.Value(tag="loss", simple_value=.25)])))
    restart.flush(); restart.close()
    (root / "tensorboard-done").write_text("done")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--steps", type=int, default=60)
    parser.add_argument("--interval", type=float, default=.2)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "wandb").mkdir(exist_ok=True)
    (root / "tensorboard").mkdir(exist_ok=True)
    jobs = [multiprocessing.Process(target=fn, args=(root, args.steps, args.interval)) for fn in (wandb_writer, tensorboard_writer)]
    for job in jobs:
        job.start()
    for job in jobs:
        job.join()
    if any(job.exitcode for job in jobs):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
