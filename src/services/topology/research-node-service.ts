import { nodeRef } from "../../domain/research/object-ref.js";
import { deleteNodeInput } from "../../domain/research/changes/operations.js";
import { fail } from "../../domain/research/access.js";

export class ResearchNodeService {
  constructor(runtime){this.runtime=runtime;this.commands=runtime.researchCommands;}
  detail(id){return this.commands.nodes.detail(id);}
  node(id){return this.commands.nodes.node(id);}
  createNode(kind,core,actor,sourceRefs=[]){
    const view=this.commands.changes.direct([{op:"addNode",clientRef:"node",kind,core,sourceRefs}],actor);
    return this.detail(view.allocation["node:node"]);
  }
  async results(id){
    const node=this.node(id);
    if(node.kind!=="experiment")fail("NODE_NOT_EXPERIMENT","此节点不是实验。",422);
    const blocks=this.commands.nodes.blocks(id);
    const sources=[...(node.sourceRefs??[]),...blocks.flatMap(block=>block.sourceRefs??[])];
    const runRefs=[...new Set(sources.map(source=>source.value).filter(value=>/^(mlflow|wandb|tensorboard|simulation):run:.+/.test(value)))];
    const results=await Promise.allSettled(runRefs.slice(0,16).map(ref=>this.runtime.registry.experiments.detail(ref,{maxPoints:240})));
    return {experiment:null,attempts:[],details:results.filter(result=>result.status==="fulfilled").map(result=>result.value),warnings:[...results.filter(result=>result.status==="rejected").map(result=>({message:result.reason?.message??"运行数据不可用"})),...(runRefs.length>16?[{message:`仅展示前 16 条运行引用，另有 ${runRefs.length-16} 条。`}]:[])],authoredMetrics:blocks.filter(block=>block.type==="metric").flatMap(block=>block.payload?.items??[]),links:blocks.flatMap(block=>[...(block.type==="link"&&block.payload?[block.payload]:[]),...(block.representations??[]).filter(rep=>rep.kind==="link")])};
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
