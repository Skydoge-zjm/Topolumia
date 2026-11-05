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

export class ResearchMcpServer {
  constructor(binding, options = {}) {
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
      return { tools: toolDefinitions(access.permissions) };
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
  async control(endpoint, body, signal) {
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw executionError(
        data.error?.code ?? "MCP_AUTHORIZATION_FAILED",
        data.error?.message ?? "科研调用未获授权。",
        { status: response.status },
      );
    return data;
  }
  async connect(transport) {
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
  acquire(write, signal) {
    if (this.closed || signal?.aborted)
      return Promise.reject(
        executionError("MCP_CANCELLED", "科研调用已取消。"),
      );
    if (this.queue.length >= 8)
      return Promise.reject(
        executionError("MCP_QUEUE_FULL", "科研调用队列已满，请稍后重试。"),
      );
    return new Promise((resolve, reject) => {
      const task = { write, resolve, reject, signal, timer: null, abort: null };
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
      task.write ? this.activeWrites++ : this.activeReads++;
      task.resolve(() => {
        task.write ? this.activeWrites-- : this.activeReads--;
        this.drain();
      });
    }
  }
  async call(name,input,signal){
    const requestId=randomUUID();let release,authorized=false,execution=null,retryKey;const tool=Object.hasOwn(researchTools,name)?researchTools[name]:null;
    try{
      if(!tool)throw executionError("MCP_TOOL_NOT_FOUND","Unknown research tool.");
      if(Buffer.byteLength(JSON.stringify(input))>262144)throw executionError("MCP_INPUT_TOO_LARGE","Input exceeds 256 KiB.");
      let value;try{value=tool.validate(input);}catch(e){throw executionError("MCP_INPUT_INVALID","Input does not match tool schema.",{detail:e.issues?inputIssues(tool.schema,input,e.issues):{message:e.message}});}
      if(name==="create_candidate"){value.idempotencyKey??=randomUUID();retryKey=value.idempotencyKey;}
      const write=Boolean(tool.write||name==="transfer_asset"&&value.direction==="upload");
      release=await this.acquire(write,signal);
      const deadline=AbortSignal.timeout(tool.transfer?110000:25000),callSignal=signal?AbortSignal.any([signal,deadline]):deadline;
      await this.control("access/authorize",{tool:name,requestId,argumentsHash:createHash("sha256").update(JSON.stringify(value)).digest("hex"),...(name==="transfer_asset"?{action:value.direction}:{})},callSignal);authorized=true;
      const command=tool.command(value),result=await this.runner.run(["--timeout-ms",tool.transfer?"90000":"15000",...command.args],command.input,{signal:callSignal,requestId,timeoutMs:tool.transfer?100000:20000});execution=result.execution;
      if(result.data.schemaVersion!=="research-agent-result.v1"||result.data.kind!==tool.kind)throw executionError("CLI_RESPONSE_INVALID","CLI response contract mismatch.",{execution});
      const visibleText=JSON.stringify(result.data),context={resultChars:visibleText.length,contentChars:visibleText.length,structuredChars:visibleText.length,toolDefinitionChars:JSON.stringify(toolDefinitions()).length,instructionsChars:MCP_INSTRUCTIONS.length};
      await this.control("access/complete",{requestId,outcome:"completed",...execution,resultId:result.data.data?.candidateId??result.data.data?.assetId??null,context}).catch(()=>{});
      return{content:[{type:"text",text:visibleText}],structuredContent:result.data,_meta:{execution:{...execution,via:"cli",contract:CLI_CONTRACT},context,requestId}};
    }catch(error){
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
