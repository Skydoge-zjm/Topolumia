import type { ResearchActor } from "../../../domain/research/types.js";
export type HistoryActorInput=Partial<ResearchActor>;
export type HistoryActor={type:string;id:string;name:string;ownerId?:string|null;sessionId?:string;model?:string|null;workbenchSessionId?:string};
/** History snapshots intentionally retain the full business object, with unknown extension fields. */
export type HistoryObject={id:string;kind?:string;type?:string;label?:unknown;summary?:unknown;description?:string;title?:string;status?:string;revision?:number;core?:{nodeName?:string;summary?:string};data?:Record<string,unknown>;[field:string]:unknown};
export type HistorySubject={type:string;id:string;kind:string;label:unknown;summary:unknown;status:string|null;version:string};
export type HistoryChange={action:string;subject:HistorySubject;before:HistoryObject|null;after:HistoryObject|null};
export type HistoryEventInput={kind:string;outcome:string;actor:HistoryActor;initiatedBy?:HistoryActor;reviewedBy?:HistoryActor;proposal?:{id:string;revision:number;status:string};reason?:string;proposalReason?:string;sourceRefs?:unknown[];evidenceNodeIds?:string[];changes:HistoryChange[];planned:boolean;beforeStateVersion?:string;afterStateVersion?:string;causedBy?:string|null};
export type HistoryEvent=HistoryEventInput&{schemaVersion:string;id:string;occurredAt:string;category:string;changeCount:number};
export type HistoryQuery={query?:string;category?:string;actor?:string;outcome?:string;objectId?:string;proposalId?:string;offset?:number;limit?:number};
