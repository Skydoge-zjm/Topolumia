import { toolRequest } from "../domain/research/interfaces/routes.js";
import type { ResearchToolInputs, ResearchToolName } from "../domain/research/interfaces/tools.js";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { clientError, researchResultSchema, wireErrorSchema } from "./research-response.js";

export type ResearchRequestOptions = Omit<RequestInit, "body"> & {
  body?: RequestInit["body"] | Readable; duplex?: "half";
};
export class ResearchClient {
  baseUrl: string; projectId: string | null; session: string | null; timeoutMs: number;
  constructor({ baseUrl, projectId = null, session = null, timeoutMs = 15000 }: {
    baseUrl?: string; projectId?: string | null; session?: string | null; timeoutMs?: number;
  } = {}) {
    this.baseUrl = String(baseUrl ?? "http://127.0.0.1:5510").replace(/\/$/, "");
    this.projectId = projectId; this.session = session; this.timeoutMs = timeoutMs;
  }
  headers(extra: NonNullable<RequestInit["headers"]> = {}) {
    const headers = new Headers({
      ...(this.projectId ? { "x-rw-project-id": this.projectId } : {}),
      ...(this.session ? { "x-rw-session": this.session } : {}),
      "x-topolumia-client": "cli",
      ...(process.env.TOPOLUMIA_REQUEST_ID ? { "x-topolumia-request-id": process.env.TOPOLUMIA_REQUEST_ID } : {}),
    });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }
  async response(route: string, options: ResearchRequestOptions = {}): Promise<Response> {
    const target = new URL(route, this.baseUrl);
    if (target.origin !== new URL(this.baseUrl).origin || !target.pathname.startsWith("/api/research/")) {
      throw Object.assign(new Error("Research URL is outside the trusted origin."), { code: "URL_FORBIDDEN" });
    }
    const body = options.body instanceof Readable ? Readable.toWeb(options.body) as ReadableStream<Uint8Array> : options.body;
    const r = await fetch(target, { ...options, body, redirect: "error", headers: this.headers(options.headers), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) {
      const payload: unknown = await r.json().catch(() => ({}));
      const parsed = wireErrorSchema.safeParse(payload && typeof payload === "object" && "error" in payload ? payload.error : {});
      const error = parsed.success ? parsed.data : {};
      throw Object.assign(new Error(error.message ?? `Request failed (${r.status})`), { code: error.code ?? "REQUEST_FAILED", status: r.status, detail: error.detail });
    }
    return r;
  }
  async request(route: string, options: ResearchRequestOptions = {}): Promise<unknown> {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return (await this.response(route, { ...options, headers })).json();
  }
  async call(name: ResearchToolName, input: Record<string, unknown>) {
    const value = name === "create_candidate" ? { ...input, idempotencyKey: input.idempotencyKey ?? randomUUID() } : input;
    const r = toolRequest(name, value);
    try { return researchResultSchema.parse(await this.request(r.path, { method: r.method, ...(r.body ? { body: r.body } : {}) })); }
    catch (cause) {
      const error = clientError(cause);
      if (name === "create_candidate") error.detail = { cause: error.detail, idempotencyKey: value.idempotencyKey, recovery: "Read candidates with this idempotencyKey or retry identical input and key." };
      throw error;
    }
  }
  context(input: ResearchToolInputs["get_context"] = {}) { return this.call("get_context", input); }
  environment(input: ResearchToolInputs["get_environment"] = {}) { return this.call("get_environment", input); }
  search(input: Partial<ResearchToolInputs["search"]> = {}) { return this.call("search", input); }
  readNode(input: Partial<ResearchToolInputs["read_nodes"]> & { nodeId?: string } = {}) { const { nodeId, ...rest } = input; return this.call("read_nodes", { ...rest, nodeIds: input.nodeIds ?? [nodeId] }); }
  readSource(input: Partial<ResearchToolInputs["read_source"]> = {}) { return this.call("read_source", input); }
  candidates(input: Partial<ResearchToolInputs["read_candidates"]> & { patchId?: string } = {}) { const { patchId, ...rest } = input; return this.call("read_candidates", { ...rest, mode: patchId ? "show" : "list", ...(patchId ? { candidateId: patchId } : {}) }); }
  neighbors(input: Partial<ResearchToolInputs["neighbors"]> = {}) { return this.call("neighbors", input); }
  createCandidate(input: Partial<ResearchToolInputs["create_candidate"]> = {}) { return this.call("create_candidate", input); }
  editCandidate(input: Partial<ResearchToolInputs["edit_candidate"]> & { patchId?: string } = {}) { const { patchId, ...rest } = input; return this.call("edit_candidate", { ...rest, candidateId: input.candidateId ?? patchId }); }
  reviewCandidate(input: { patchId?: string; candidateId?: string; decision?: string; reason?: string; expectedRevision?: number } = {}) {
    return this.request(`/api/research/candidates/${encodeURIComponent(input.patchId ?? input.candidateId ?? "")}/review`, { method: "POST", body: JSON.stringify({ decision: input.decision, reason: input.reason, expectedRevision: input.expectedRevision }) });
  }
}
