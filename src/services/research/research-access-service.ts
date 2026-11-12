import { AppError } from "../../lib/errors.js";
import {
  CLI_CONTRACT,
  RESEARCH_INTERFACE,
  researchTools,
  toolPermission,
  isWrite,
} from "../../domain/research/research-mcp-contract.js";
import { requirePermission } from "./research-command-service.js";
import * as z from "zod/v4";

const startSchema = z.strictObject({
  tool: z.string().max(80),
  requestId: z.uuid(),
  action: z.enum(["upload", "download"]).optional(),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const completeSchema = z.strictObject({
  requestId: z.uuid(),
  action: z.enum(["upload", "download"]).optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
  pid: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().nullable().optional(),
  resultId: z.string().max(240).nullable().optional(),
  errorCode: z.string().max(120).optional(),
  context: z
    .strictObject({
      resultChars: z.number().int().nonnegative().optional(),
      contentChars: z.number().int().nonnegative().optional(),
      structuredChars: z.number().int().nonnegative().optional(),
      estimatedResultTokens: z.number().int().nonnegative().optional(),
      toolDefinitionChars: z.number().int().nonnegative().optional(),
      instructionsChars: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
import type { DatabaseSync } from "node:sqlite";
import type { ResearchActor, AuthenticatedResearchActor, DatabaseOwner } from "../../domain/research/types.js";
export class ResearchAccessService {
  db:DatabaseSync;
  projectId:string;
  constructor(collaboration:DatabaseOwner, projectId:string) {
    this.db = collaboration.db;
    this.projectId = projectId;
    this.db.exec(`CREATE TABLE IF NOT EXISTS research_tool_calls (
      request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, research_session_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL, tool TEXT NOT NULL, is_write INTEGER NOT NULL, arguments_hash TEXT NOT NULL,
      outcome TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER,
      pid INTEGER, duration_ms INTEGER, exit_code INTEGER, result_id TEXT, error_code TEXT,
      result_chars INTEGER, content_chars INTEGER, structured_chars INTEGER, estimated_result_tokens INTEGER,
      tool_definition_chars INTEGER, instructions_chars INTEGER)`);
    for (const column of [
      "result_chars",
      "content_chars",
      "structured_chars",
      "estimated_result_tokens",
      "tool_definition_chars",
      "instructions_chars",
    ]) {
      try {
        this.db.exec(
          `ALTER TABLE research_tool_calls ADD COLUMN ${column} INTEGER`,
        );
      } catch {
        /* already exists */
      }
    }
  }
  private requireActor(actor:ResearchActor):asserts actor is AuthenticatedResearchActor & {runtimeInstanceId:string;sessionId:string} {
    if (!actor?.isAgent || !actor.runtimeInstanceId || !actor.sessionId)
      throw new AppError(
        "MCP_AGENT_REQUIRED",
        "科研 MCP 需要会话绑定的 Agent 身份。",
        { status: 403 },
      );
    requirePermission(actor, "research.view");
    if (actor.projectId !== this.projectId)
      throw new AppError("MCP_PROJECT_MISMATCH", "科研项目不匹配。", {
        status: 403,
      });
  }
  access(actor:ResearchActor) {
    this.requireActor(actor);
    return {
      schemaVersion: "research-access.v1",
      researchInterface: RESEARCH_INTERFACE,
      cliContract: CLI_CONTRACT,
      projectId: this.projectId,
      researchSessionId: actor.sessionId,
      runtimeInstanceId: actor.runtimeInstanceId,
      permissions: actor.permissions,
    };
  }
  authorize(actor:ResearchActor, input:unknown) {
    this.requireActor(actor);
    const parsed = startSchema.safeParse(input);
    if (!parsed.success || !Object.hasOwn(researchTools, parsed.data.tool))
      throw new AppError("MCP_REQUEST_INVALID", "科研工具授权请求无效。", {
        status: 422,
      });
    const value = parsed.data;
    if(value.tool === "transfer_asset" && !value.action) throw new AppError("MCP_REQUEST_INVALID", "Transfer action is required.", {status:422});
    if (!actor.permissions.includes(toolPermission(value.tool, { direction: value.action }))) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO research_tool_calls(request_id,project_id,user_id,research_session_id,runtime_instance_id,tool,is_write,arguments_hash,outcome,started_at,expires_at,completed_at,error_code) VALUES(?,?,?,?,?,?,?,?,'denied',?,?,?,'FORBIDDEN')",
        )
        .run(
          value.requestId,
          this.projectId,
          actor.user.id,
          actor.sessionId,
          actor.runtimeInstanceId,
          value.tool,
          isWrite(value.tool, { direction: value.action }) ? 1 : 0,
          value.argumentsHash,
          Date.now(),
          Date.now(),
          Date.now(),
        );
      requirePermission(actor, toolPermission(value.tool, { direction: value.action }));
    }
    const at = Date.now();
    this.db
      .prepare(
        "UPDATE research_tool_calls SET outcome='unknown', completed_at=?, error_code='MCP_LEASE_EXPIRED' WHERE outcome='running' AND expires_at<=?",
      )
      .run(at, at);
    const active = this.db
      .prepare(
        "SELECT count(*) AS count FROM research_tool_calls WHERE project_id=? AND outcome='running'",
      )
      .get(this.projectId);
    if (Number(active?.count) >= 16)
      throw new AppError("MCP_PROJECT_BUSY", "项目科研调用已达并发上限。", {
        status: 429,
      });
    const own = this.db
      .prepare(
        "SELECT count(*) AS count FROM research_tool_calls WHERE project_id=? AND runtime_instance_id=? AND outcome='running' AND is_write=?",
      )
      .get(
        this.projectId,
        actor.runtimeInstanceId,
        isWrite(value.tool, { direction: value.action }) ? 1 : 0,
      );
    if (Number(own?.count) >= (isWrite(value.tool, { direction: value.action }) ? 1 : 2))
      throw new AppError("MCP_SESSION_BUSY", "会话科研调用已达并发上限。", {
        status: 429,
      });
    try {
      this.db
        .prepare(
          "INSERT INTO research_tool_calls(request_id,project_id,user_id,research_session_id,runtime_instance_id,tool,is_write,arguments_hash,outcome,started_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'running',?,?)",
        )
        .run(
          value.requestId,
          this.projectId,
          actor.user.id,
          actor.sessionId,
          actor.runtimeInstanceId,
          value.tool,
          isWrite(value.tool, { direction: value.action }) ? 1 : 0,
          value.argumentsHash,
          at,
          at + (value.tool === "transfer_asset" ? 120000 : 30000),
        );
    } catch {
      throw new AppError("MCP_REQUEST_REPLAY", "科研请求 ID 已使用。", {
        status: 409,
      });
    }
    return { authorized: true, requestId: value.requestId };
  }
  complete(actor:ResearchActor, input:unknown) {
    this.requireActor(actor);
    const parsed = completeSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("MCP_AUDIT_INVALID", "科研调用结果格式无效。", {
        status: 422,
      });
    const value = parsed.data;
    const context = value.context ?? {};
    const result = this.db
      .prepare(
        "UPDATE research_tool_calls SET outcome=?,completed_at=?,pid=?,duration_ms=?,exit_code=?,result_id=?,error_code=?,result_chars=?,content_chars=?,structured_chars=?,estimated_result_tokens=?,tool_definition_chars=?,instructions_chars=? WHERE request_id=? AND project_id=? AND runtime_instance_id=? AND user_id=? AND outcome='running'",
      )
      .run(
        value.outcome,
        Date.now(),
        value.pid ?? null,
        value.durationMs ?? null,
        value.exitCode ?? null,
        value.resultId ?? null,
        value.errorCode ?? null,
        context.resultChars ?? null,
        context.contentChars ?? null,
        context.structuredChars ?? null,
        context.estimatedResultTokens ?? null,
        context.toolDefinitionChars ?? null,
        context.instructionsChars ?? null,
        value.requestId,
        this.projectId,
        actor.runtimeInstanceId,
        actor.user.id,
      );
    if (!result.changes)
      throw new AppError(
        "MCP_REQUEST_NOT_FOUND",
        "没有找到当前运行实例的科研请求。",
        { status: 404 },
      );
    return { recorded: true };
  }
}
