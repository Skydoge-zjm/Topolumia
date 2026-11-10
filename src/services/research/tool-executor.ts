import { researchTools, isResearchToolName } from "../../domain/research/interfaces/tools.js";
import type { ResearchToolName, ResearchToolInputs } from "../../domain/research/interfaces/tools.js";
import { readResearchEnvironmentContext } from "../environments/research-environment-context.js";
import type { EnvironmentRuntime } from "../environments/research-environment-context.js";
import type { SshEnvironmentHub } from "../../ssh/ssh-environment-hub.js";
import type { ResearchCommandService } from "./research-command-service.js";
import type { ResearchActor } from "../../domain/research/types.js";
import * as z from "zod/v4";
import { fail } from "../../domain/research/access.js";
import { inputIssues } from "../../domain/research/interfaces/input-errors.js";
export async function executeResearchTool(runtime:EnvironmentRuntime&{researchCommands:ResearchCommandService},name:string,input:unknown,actor:ResearchActor,sshEnvironments:SshEnvironmentHub){
  if(!isResearchToolName(name))fail("MCP_TOOL_NOT_FOUND","Unknown tool.");
  const validate=<K extends ResearchToolName>(tool:K):ResearchToolInputs[K]=>{try{return researchTools[tool].validate(input);}catch(error){if(error instanceof z.ZodError)fail("INPUT_INVALID","Tool input does not match schema.",422,inputIssues(researchTools[tool].schema,input,error.issues));throw error;}};
  const params=<K extends ResearchToolName>(tool:K)=>({...validate(tool),actor});
  const c:ResearchCommandService=runtime.researchCommands,q=c.queries;
  switch(name){
    case"read_experiment":return c.records.read(validate(name),actor);
    case"get_context":return q.brief(params(name));
    case"get_environment":{const value=params(name);return q.finish(q.envelope("environment",await readResearchEnvironmentContext({runtime,actor,sshEnvironments,locale:value.locale??"zh"}),{...value,maxChars:4000}));}
    case"search":return q.search(params(name));
    case"read_nodes":return q.readNodes(params(name));
    case"read_groups":return q.readGroups(params(name));
    case"neighbors":return q.neighbors(params(name));
    case"read_source":return q.readSource(params(name));
    case"read_blocks":return q.readBlocks(params(name));
    case"read_assets":return q.readAssets(params(name));
    case"get_schema":return q.schema(params(name));
    case"read_candidates":return q.candidates(params(name));
    case"create_candidate":case"edit_candidate":{
      const value=validate(name);c.check(actor,"research.proposeChange");
      if(!actor.isAgent)for(const change of value.nodeChanges??[])if(change.experimentPatch)await c.records.prepareMaterialSelections(change.experimentPatch,actor);
      const candidate=name==="create_candidate"?c.proposals.create(value,actor):c.proposals.edit(value,actor);
      return q.candidateReceipt(candidate,actor);
    }
  }
  fail("MCP_TOOL_NOT_FOUND","Unknown tool.");
}
