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
