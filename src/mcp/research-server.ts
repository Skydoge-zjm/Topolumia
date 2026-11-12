import { randomUUID, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CLI_CONTRACT,
  MCP_INSTRUCTIONS,
  RESEARCH_INTERFACE,
  researchTools,
  toolDefinitions,
} from "../domain/research/research-mcp-contract.js";
import { ResearchCliRunner, executionError } from "./cli-runner.js";
import { inputIssues } from "../domain/research/interfaces/input-errors.js";
import { isResearchToolName, type ResearchToolInputs, type ResearchToolName } from "../domain/research/interfaces/tools.js";
import type { ResearchMcpBinding } from "../domain/agents/agent-types.js";
import type { CliRunnerOptions, CliExecution } from "./cli-runner.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clientError, researchResultSchema, wireErrorSchema } from "../client/research-response.js";
import * as z from "zod/v4";

const controlResponseSchema = z.looseObject({ permissions: z.array(z.string()).optional(), researchInterface: z.string().optional(), cliContract: z.string().optional(), error: wireErrorSchema.optional() });
interface QueueTask {
  write: boolean; signal?: AbortSignal; timer?: ReturnType<typeof setTimeout>; abort: () => void;
  resolve: (release: () => void) => void; reject: (error: unknown) => void;
}
type Runner = Pick<ResearchCliRunner, "run" | "checkContract" | "close">;
function researchCommand<K extends ResearchToolName>(name: K, value: ResearchToolInputs[K]) { return researchTools[name].command(value); }

export class ResearchMcpServer {
  binding: Pick<ResearchMcpBinding, "env" | "cwd">; runner: Runner;
  queue: QueueTask[]; activeReads: number; activeWrites: number; closed: boolean; server: Server;
  constructor(binding: Pick<ResearchMcpBinding, "env" | "cwd">, options: CliRunnerOptions & { runner?: Runner } = {}) {
    this.binding = binding;
    this.runner = options.runner ?? new ResearchCliRunner(binding, options);
    this.queue = [];
    this.activeReads = 0;
    this.activeWrites = 0;
    this.closed = false;
    this.server = new Server(
      { name: "topolumia", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const access = await this.control("access");
      return { tools: toolDefinitions(access.permissions).map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, type: "object" as const } })) };
    });
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) =>
        this.call(
          request.params.name,
          request.params.arguments ?? {},
          extra.signal,
        ),
    );
  }
  async control(endpoint: string, body?: unknown, signal?: AbortSignal) {
    let response;
    try {
      response = await fetch(
        new URL(`/api/research/${endpoint}`, this.binding.env.TOPOLUMIA_URL),
        {
          method: body ? "POST" : "GET",
          headers: {
            "x-rw-project-id": this.binding.env.TOPOLUMIA_PROJECT_ID,
            "x-rw-session": this.binding.env.TOPOLUMIA_SESSION,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw executionError("MCP_CONTROL_UNAVAILABLE", "科研授权服务不可用。");
    }
    const data = controlResponseSchema.parse(await response.json().catch(() => ({})));
    if (!response.ok)
      throw executionError(
        data.error?.code ?? "MCP_AUTHORIZATION_FAILED",
        data.error?.message ?? "科研调用未获授权。",
        { status: response.status },
      );
    return data;
  }
  async connect(transport: Transport) {
    const access = await this.control("access");
    if (
      access.researchInterface !== RESEARCH_INTERFACE ||
      access.cliContract !== CLI_CONTRACT
    )
      throw executionError("MCP_CONTRACT_MISMATCH", "科研接口合同不兼容。");
    await this.runner.checkContract();
    this.server.onclose = () => {
      void this.close();
    };
    await this.server.connect(transport);
  }
  acquire(write: boolean, signal?: AbortSignal): Promise<() => void> {
    if (this.closed || signal?.aborted)
      return Promise.reject(
        executionError("MCP_CANCELLED", "科研调用已取消。"),
      );
    if (this.queue.length >= 8)
      return Promise.reject(
        executionError("MCP_QUEUE_FULL", "科研调用队列已满，请稍后重试。"),
      );
    return new Promise<() => void>((resolve, reject) => {
      const task: QueueTask = { write, resolve, reject, signal, abort: () => {} };
      task.abort = () => {
        const index = this.queue.indexOf(task);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(task.timer);
        signal?.removeEventListener("abort", task.abort);
        reject(executionError("MCP_CANCELLED", "科研排队已取消。"));
      };
      task.timer = setTimeout(() => task.abort(), 20000);
      task.timer.unref?.();
      signal?.addEventListener("abort", task.abort, { once: true });
      this.queue.push(task);
      this.drain();
    });
  }
  drain() {
    for (let i = 0; i < this.queue.length;) {
      const task = this.queue[i];
      if (task.write ? this.activeWrites >= 1 : this.activeReads >= 2) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      clearTimeout(task.timer);
      task.signal?.removeEventListener("abort", task.abort);
      if (task.write) this.activeWrites++; else this.activeReads++;
      task.resolve(() => {
        if (task.write) this.activeWrites--; else this.activeReads--;
        this.drain();
      });
    }
  }
  async call(name: string,input: unknown,signal?: AbortSignal): Promise<CallToolResult>{
    const requestId=randomUUID();let release: (() => void) | undefined,authorized=false,execution: CliExecution | null=null,retryKey: string | undefined;
    const toolName=isResearchToolName(name)?name:null,tool=toolName?researchTools[toolName]:null;
    try{
      if(!tool||!toolName)throw executionError("MCP_TOOL_NOT_FOUND","Unknown research tool.");
      if(Buffer.byteLength(JSON.stringify(input))>262144)throw executionError("MCP_INPUT_TOO_LARGE","Input exceeds 256 KiB.");
      let value: ResearchToolInputs[ResearchToolName];try{value=tool.validate(input);}catch(cause){throw executionError("MCP_INPUT_INVALID","Input does not match tool schema.",{detail:cause instanceof z.ZodError?inputIssues(tool.schema,input,cause.issues):{message:clientError(cause).message}});}
      if(name==="create_candidate"){const candidate=researchTools.create_candidate.validate(value);candidate.idempotencyKey??=randomUUID();retryKey=candidate.idempotencyKey;value=candidate;}
      const direction="direction" in value?value.direction:undefined;
      const write=Boolean(tool.write||name==="transfer_asset"&&direction==="upload");
      release=await this.acquire(write,signal);
      const deadline=AbortSignal.timeout(tool.transfer?110000:25000),callSignal=signal?AbortSignal.any([signal,deadline]):deadline;
      await this.control("access/authorize",{tool:name,requestId,argumentsHash:createHash("sha256").update(JSON.stringify(value)).digest("hex"),...(name==="transfer_asset"?{action:direction}:{})},callSignal);authorized=true;
      const command=researchCommand(toolName,value),result=await this.runner.run(["--timeout-ms",tool.transfer?"90000":"15000",...command.args],command.input,{signal:callSignal,requestId,timeoutMs:tool.transfer?100000:20000});execution=result.execution;
      const parsed=researchResultSchema.safeParse(result.data);
      if(!parsed.success||parsed.data.kind!==tool.kind)throw executionError("CLI_RESPONSE_INVALID","CLI response contract mismatch.",{execution});
      const data=parsed.data,visibleText=JSON.stringify(data),context={resultChars:visibleText.length,contentChars:visibleText.length,structuredChars:visibleText.length,toolDefinitionChars:JSON.stringify(toolDefinitions()).length,instructionsChars:MCP_INSTRUCTIONS.length};
      await this.control("access/complete",{requestId,outcome:"completed",...execution,resultId:data.data.candidateId??data.data.assetId??null,context}).catch(()=>{});
      return{content:[{type:"text",text:visibleText}],structuredContent:data,_meta:{execution:{...execution,via:"cli",contract:CLI_CONTRACT},context,requestId}};
    }catch(cause){
      const error=clientError(cause);
      const uncertain=Boolean((tool?.write||name==="transfer_asset")&&authorized&&(error.execution?.pid||execution?.pid)&&(error.exitCode===undefined||error.exitCode===5));
      const data={error:{code:error.code??"MCP_CALL_FAILED",message:String(error.message).slice(0,400),requestId,...(error.detail?{detail:error.detail}:{}),...(retryKey?{idempotencyKey:retryKey}:{}),outcome:uncertain?"unknown":error.outcome??"failed",retryable:!tool?.write&&error.code==="MCP_CONTROL_UNAVAILABLE",...(uncertain?{recovery:"Read candidates with the returned idempotencyKey, or retry identical input with that key. For an edit, read the candidate revision before retrying."}:{})}};
      if(authorized)await this.control("access/complete",{requestId,outcome:data.error.outcome,...(error.execution??execution??{}),errorCode:data.error.code}).catch(()=>{});
      return{isError:true,content:[{type:"text",text:JSON.stringify(data)}],structuredContent:data};
    }finally{release?.();}
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const task of [...this.queue]) task.abort();
    await this.runner.close();
    await this.server.close();
  }
}
