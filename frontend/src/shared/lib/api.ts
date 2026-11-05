import type { ApiErrorShape } from "@/shared/types/api";

export class ApiClientError extends Error {
  status: number;
  code?: string;
  detail?: unknown;

  constructor(message: string, status: number, payload?: ApiErrorShape) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = payload?.code;
    this.detail = payload?.detail;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
  cached?: T,
): Promise<T> {
  const projectId = window.localStorage.getItem("research-workbench-project");
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (projectId && !headers.has("x-rw-project-id"))
    headers.set("x-rw-project-id", projectId);
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  if (response.status === 304 && cached !== undefined) return cached;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload?.error as ApiErrorShape | undefined;
    throw new ApiClientError(
      error?.message ?? `请求失败（${response.status}）`,
      response.status,
      error,
    );
  }
  return payload as T;
}

export function projectId(): string {
  return window.localStorage.getItem("research-workbench-project") ?? "";
}
