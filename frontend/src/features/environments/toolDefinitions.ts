export type Field = {
  key: string;
  zh: string;
  en: string;
  placeholder?: string;
  required?: boolean;
  environmentVariable?: boolean;
};
export const fields: Record<string, Field[]> = {
  conda: [
    {
      key: "command",
      zh: "Conda 可执行文件",
      en: "Conda executable",
      placeholder: "conda",
      required: true,
    },
  ],
  uv: [
    {
      key: "command",
      zh: "uv 可执行文件",
      en: "uv executable",
      placeholder: "uv",
      required: true,
    },
  ],
  nvidia: [
    {
      key: "command",
      zh: "nvidia-smi 可执行文件",
      en: "nvidia-smi executable",
      placeholder: "nvidia-smi",
      required: true,
    },
  ],
  cuda: [
    {
      key: "command",
      zh: "nvcc 可执行文件",
      en: "nvcc executable",
      placeholder: "nvcc",
      required: true,
    },
  ],
  python: [
    {
      key: "command",
      zh: "Python 可执行文件",
      en: "Python executable",
      placeholder: "python",
      required: true,
    },
  ],
  mlflow: [
    {
      key: "baseUrl",
      zh: "服务地址",
      en: "Server URL",
      placeholder: "http://127.0.0.1:5000",
    },
    {
      key: "experimentName",
      zh: "实验名称",
      en: "Experiment name",
      required: true,
    },
    {
      key: "experimentId",
      zh: "实验 ID（可选）",
      en: "Experiment ID (optional)",
    },
    {
      key: "tokenEnv",
      zh: "令牌环境变量",
      en: "Token environment variable",
      required: true,
      environmentVariable: true,
    },
  ],
  wandb: [
    {
      key: "baseUrl",
      zh: "服务地址",
      en: "Server URL",
      placeholder: "https://api.wandb.ai",
    },
    { key: "entity", zh: "组织或用户名", en: "Entity", required: true },
    { key: "project", zh: "实验项目", en: "Tracking project", required: true },
    {
      key: "tokenEnv",
      zh: "令牌环境变量",
      en: "Token environment variable",
      required: true,
      environmentVariable: true,
    },
  ],
  tensorboard: [
    {
      key: "logdir",
      zh: "项目内日志目录",
      en: "Log directory within this project",
      placeholder: "logs/tensorboard",
    },
  ],
};
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";
