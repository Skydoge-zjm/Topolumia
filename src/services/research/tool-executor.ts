import { researchTools } from "../../domain/research/interfaces/tools.js";
import { readResearchEnvironmentContext } from "../environments/research-environment-context.js";
import { fail } from "../../domain/research/access.js";
import { inputIssues } from "../../domain/research/interfaces/input-errors.js";
export async function executeResearchTool(runtime,name,input,actor,sshEnvironments){
  let value;try{value=researchTools[name].validate(input);}catch(e){if(e.issues)fail("INPUT_INVALID","Tool input does not match schema.",422,inputIssues(researchTools[name].schema,input,e.issues));throw e;}
  const c=runtime.researchCommands,q=c.queries,params={...value,actor};
  switch(name){
    case"read_experiment":return c.records.read(value,actor);
    case"get_context":return q.brief(params);
    case"get_environment":return q.finish(q.envelope("environment",await readResearchEnvironmentContext({runtime,actor,sshEnvironments,locale:value.locale??"zh"}),{...params,maxChars:4000}));
    case"search":return q.search(params);
    case"read_nodes":return q.readNodes(params);
    case"read_groups":return q.readGroups(params);
    case"neighbors":return q.neighbors(params);
    case"read_source":return q.readSource(params);
    case"read_blocks":return q.readBlocks(params);
    case"read_assets":return q.readAssets(params);
    case"get_schema":return q.schema(params);
    case"read_candidates":return q.candidates(params);
    case"create_candidate":case"edit_candidate":{
      c.check(actor,"research.proposeChange");
      if(!actor.isAgent)for(const change of value.nodeChanges??[])if(change.experimentPatch)await c.records.prepareMaterialSelections(change.experimentPatch,actor);
      const p=name==="create_candidate"?c.proposals.create(value,actor):c.proposals.edit(value,actor);
      return q.candidateReceipt(p, actor);
    }
  }
  fail("MCP_TOOL_NOT_FOUND","Unknown tool.");
}
