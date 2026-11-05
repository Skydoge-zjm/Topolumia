export const sourceLabel = (id: string, en: boolean, remote = false) =>
  id === "python"
    ? en
      ? remote
        ? "Remote Python"
        : "Local Python"
      : remote
        ? "远程 Python"
        : "本机 Python"
    : id === "conda"
      ? "Conda"
      : "venv";
export const componentLabel = (id: string) =>
  ({
    python: "Python",
    jupyter: "Jupyter",
    tensorboard: "TensorBoard",
    wandb: "Weights & Biases",
    mlflow: "MLflow",
    torch: "PyTorch",
    jax: "JAX",
    tensorflow: "TensorFlow",
    cuda: "CUDA Toolkit",
  })[id] ?? id;
export const currentName = (name: string, en: boolean) =>
  name === "default"
    ? en
      ? "Default Python"
      : "默认 Python"
    : name === "custom"
      ? en
        ? "Custom interpreter"
        : "指定解释器"
      : name;
