import * as z from "zod/v4";
import { AppError } from "../../lib/errors.js";
import type { AppConfig } from "../../config.js";

/** Connection diagnostics do not own experiment data or a second query path. */
export class WandbConnectionProbe {
  constructor(readonly config: AppConfig) {}
  async requestGraphql(query: string, variables: Record<string, string>) {
    const config = this.config.wandb, token = process.env[config.tokenEnv];
    const response = await fetch(config.baseUrl.replace(/\/+$/, "") + config.graphqlPath, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: config.authScheme === "bearer" ? `Bearer ${token}` : `Basic ${Buffer.from("api:" + token).toString("base64")}` } : {}) },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new AppError("WANDB_HTTP_ERROR", `W&B 请求失败：HTTP ${response.status}`, { status: 503 });
    return z.object({ data: z.object({ project: z.object({ id: z.string(), name: z.string() }).nullable() }), errors: z.array(z.unknown()).optional() }).parse(await response.json()).data;
  }
}
