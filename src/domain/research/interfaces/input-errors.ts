import type * as z from "zod/v4";
type SchemaNode = {type?:string;unwrap?:()=>SchemaNode;removeDefault?:()=>SchemaNode;def?:{discriminator?:string};options?:SchemaNode[];shape?:Record<string,SchemaNode>;element?:SchemaNode;valueType?:SchemaNode;safeParse?:(value:unknown)=>{success:boolean}};
const field=(value:unknown,key:PropertyKey):unknown=>value!==null&&typeof value==="object" ? (value as Record<PropertyKey,unknown>)[key] : undefined;
/** Keep validation errors actionable without requiring another schema lookup. */
export function inputIssues(schema:z.ZodType, input:unknown, issues:readonly z.core.$ZodIssue[]) {
  const unwrap = (node:SchemaNode|undefined, value:unknown):SchemaNode|undefined => {
    for (;;) {
      if (["optional", "nullable", "default"].includes(node?.type??"")) node = node?.unwrap ? node.unwrap() : node?.removeDefault?.();
      else if (node?.type === "union" && node.def?.discriminator) {
        const key = node.def.discriminator;
        node = node.options?.find(option => option.shape?.[key]?.safeParse?.(field(value,key)).success);
      } else return node;
    }
  };
  return issues.slice(0, 6).map(issue => {
    let node:SchemaNode|undefined = schema as unknown as SchemaNode, value = input;
    for (const key of issue.path) {
      node = unwrap(node, value);
      node = typeof key === "number" ? node?.element : typeof key === "symbol" ? undefined : node?.shape?.[key] ?? node?.valueType;
      value = field(value,key);
    }
    node = unwrap(node, value);
    const allowedFields = node?.shape ? Object.keys(node.shape) : undefined;
    return {
      path: issue.path.join("."), message: issue.message,
      ...(issue.code === "unrecognized_keys" && allowedFields ? { allowedFields, recovery: "Use only these fields. Preserve other research details in freely titled content blocks." } : {}),
      ...("values" in issue ? { allowedValues: issue.values } : {}),
    };
  });
}
