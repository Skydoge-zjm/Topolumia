export const researchObjectKinds = ["node", "group"] as const;
export type NodeRef = {kind:"node";id:string};
export type GroupRef = {kind:"group";id:string};
export type ResearchObjectRef = NodeRef | GroupRef;
export const objectKey = (object: ResearchObjectRef) => JSON.stringify([object.kind, object.id]);
export const sameObject = (a: ResearchObjectRef | undefined, b: ResearchObjectRef | undefined) => Boolean(a && b && a.kind === b.kind && a.id === b.id);
export const nodeRef = (id: string): NodeRef => ({ kind: "node", id });
export const groupRef = (id: string): GroupRef => ({ kind: "group", id });
