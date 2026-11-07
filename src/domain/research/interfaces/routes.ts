export function toolRequest(name,input){
  const id=encodeURIComponent;
  if(name==="read_experiment")return{method:"POST",path:"/api/research/experiments/read",body:JSON.stringify(input)};
  const definitions={get_context:["GET","/api/research/context"],get_environment:["GET","/api/research/environment"],search:["GET","/api/research/search"],read_nodes:["GET","/api/research/nodes"],read_groups:["GET","/api/research/groups"],neighbors:["GET","/api/research/neighbors"],read_source:["GET","/api/research/sources"],read_blocks:input.mode==="list"?["GET","/api/research/blocks"]:["POST","/api/research/blocks/read"],read_assets:input.view&&input.view!=="metadata"?["POST",`/api/research/assets/${id(input.assetId)}/read`]:["GET",`/api/research/assets/${id(input.assetId)}`],get_schema:["GET","/api/research/schemas"],read_candidates:input.mode==="show"?["GET",`/api/research/candidates/${id(input.candidateId)}`]:["GET","/api/research/candidates"],create_candidate:["POST","/api/research/candidates"],edit_candidate:["PATCH",`/api/research/candidates/${id(input.candidateId)}`]};
  const [method,route]=definitions[name]??[];if(!method)throw new Error("No registered HTTP mapping.");
  if(method==="GET"){const p=new URLSearchParams();for(const[k,v]of Object.entries(input))if(v!==undefined)p.set(k,typeof v==="object"?JSON.stringify(v):String(v));p.set("viewMode","agent");return {method,path:route+"?"+p};}
  return{method,path:route,body:JSON.stringify(input)};
}
