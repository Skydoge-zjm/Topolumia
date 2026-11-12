export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: { cause?: unknown; status?: number; detail?: unknown; retryable?: boolean } = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? 500;
    this.detail = options.detail ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL_ERROR", "服务处理请求时发生未预期错误。", {
    status: 500,
    detail: { reason: error instanceof Error ? error.message : String(error) },
    cause: error,
  });
}

export function errorPayload(error: unknown) {
  const appError = asAppError(error);
  return {
    error: {
      code: appError.code,
      message: appError.message,
      detail: appError.detail,
      retryable: appError.retryable,
    },
  };
}
