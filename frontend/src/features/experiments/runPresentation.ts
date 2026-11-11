export const runStatusNames = {
  unknown: ["未知", "Unknown"],
  queued: ["排队中", "Queued"],
  running: ["运行中", "Running"],
  succeeded: ["成功", "Succeeded"],
  failed: ["失败", "Failed"],
  cancelled: ["已取消", "Cancelled"],
};
export const runStatusLabel = (status: string, en: boolean) =>
  runStatusNames[status as keyof typeof runStatusNames]?.[en ? 1 : 0] ?? status;
/** Reading order for summaries: what is happening now, what failed, then the rest. */
export const runStatusOrder = ["running", "queued", "failed", "succeeded", "cancelled", "unknown"];
export const providerLabel = (provider: string) =>
  provider === "wandb" ? "W&B" : provider === "tensorboard" ? "TensorBoard" : provider === "mlflow" ? "MLflow" : provider;
