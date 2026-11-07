"""Generate synthetic offline records using the actual W&B/TensorBoard writers."""
from __future__ import annotations
import argparse
import json
import os
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.environ["WANDB_MODE"] = "offline"
    os.environ["WANDB_SILENT"] = "true"
    os.environ["WANDB_CONSOLE"] = "off"
    import wandb
    from tensorboard.summary.writer.event_file_writer import EventFileWriter
    from tensorboard.compat.proto.event_pb2 import Event
    from tensorboard.compat.proto.summary_pb2 import Summary

    for index in range(3):
        run = wandb.init(project="topolumia-native-fixture", id=f"record-{index}", name=f"Native run {index + 1}",
                         dir=str(root), mode="offline", config={"rank": 4, "batch_size": 32 if index == 0 else 16, "fragment_test": "x" * 70000},
                         settings=wandb.Settings(console="off", disable_git=True))
        for step in range(0 if index == 0 else 8):
            run.log({"train/loss": 1 / (step + index + 1), "train/accuracy": step / 10,
                     "eval/psnr": 20 + step / 10, "eval/ssim": step / 20}, step=step)
        run.finish(exit_code=1 if index == 0 else 0)
    event_dir = root / "tensorboard-run"
    writer = EventFileWriter(str(event_dir))
    for step in range(8):
        values = {"train/loss": 1 / (step + 1), "train/accuracy": step / 10, "eval/psnr": 20 + step / 10, "eval/ssim": step / 20}
        writer.add_event(Event(wall_time=time.time(), step=step, summary=Summary(value=[Summary.Value(tag=key, simple_value=value) for key, value in values.items()])))
    writer.flush()
    writer.close()
    print(json.dumps({"wandb": [str(file) for file in sorted(root.glob("wandb/offline-run-*/*.wandb"))],
                      "tensorboard": [str(file) for file in sorted(event_dir.glob("*tfevents*"))],
                      "versions": {"wandb": wandb.__version__}}, ensure_ascii=True))


if __name__ == "__main__":
    main()
