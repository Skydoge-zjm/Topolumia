import { nodeRef } from "../../domain/research/object-ref.js";
import { deleteNodeInput } from "../../domain/research/changes/operations.js";
import { fail } from "../../domain/research/access.js";

export class ResearchNodeService {
  constructor(runtime){this.runtime=runtime;this.commands=runtime.researchCommands;}
  detail(id){return this.commands.nodes.detail(id);}
  node(id){return this.commands.nodes.node(id);}
  createNode(kind,core,actor,sourceRefs=[],body=undefined){
    const operations: any[] = [{op:"addNode",clientRef:"node",kind,core,sourceRefs}];
    if (kind === "note" && body !== undefined) operations.push({op:"addBlock",clientRef:"body",owner:nodeRef("@node"),title:"正文",type:"richText",role:"body",payload:{format:"markdown",body}});
    const view=this.commands.changes.direct(operations,actor);
    return this.detail(view.allocation["node:node"]);
  }
  updateCore(id,patch,actor,expectedCoreRevision){this.commands.changes.direct([{op:"updateCore",owner:nodeRef(id),expectedCoreRevision,patch}],actor);return this.detail(id);}
  deleteNode(id,input,actor){
    this.commands.check(actor,"research.withdrawOrSupersede");
    const value=this.commands.changes.validate(deleteNodeInput,input),node=this.node(id);
    if(node.revision!==value.expectedNodeRevision)fail("NODE_VERSION_CONFLICT","节点内容已更新，请重新载入并核对后再删除。",409,{nodeId:id,expected:value.expectedNodeRevision,current:node.revision});
    const view=this.commands.changes.direct([{op:"deleteNode",nodeId:id,...value}],actor,value.reason);
    return {deleted:true,id,stateVersion:view.topology.stateVersion,historyId:this.runtime.history.list({objectId:id,limit:1}).items[0]?.id};
  }
}
