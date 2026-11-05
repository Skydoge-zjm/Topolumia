export const researchObjectKinds = ["node", "group"] as const;
export type ResearchObjectRef = { kind: typeof researchObjectKinds[number]; id: string };
export const objectKey = (object: ResearchObjectRef) => JSON.stringify([object.kind, object.id]);
export const sameObject = (a: ResearchObjectRef | undefined, b: ResearchObjectRef | undefined) => Boolean(a && b && a.kind === b.kind && a.id === b.id);
export const nodeRef = (id: string): ResearchObjectRef => ({ kind: "node", id });
export const groupRef = (id: string): ResearchObjectRef => ({ kind: "group", id });
