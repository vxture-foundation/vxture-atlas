import type { ApplicationType } from "../types/runtime.types";

/** A3 rerank (docs/30-design/200-s2s-provider-surface.md §4). */
export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankRequest {
  /** Exactly one of modelCode / endpointCode / taskProfile must resolve to a model. */
  modelCode?: string;
  /**
   * Endpoint routing - see `ChatRequest.endpointCode`. The endpoint's
   * `fallbackModelCode` DOES apply here, identically to chat: all four
   * data-plane surfaces run the same `runWithS2sFailover` loop.
   */
  endpointCode?: string;
  /** Task-profile routing (docs/70-workplan) - see `ChatRequest.taskProfile`. */
  taskProfile?: string;
  query: string;
  candidates: RerankCandidate[];
  workspaceId: string;
  tenantId?: string;
  applicationId?: string;
  applicationType?: ApplicationType;
  requestId?: string;
  /**
   * product_251 X-2: the agent TASK this call belongs to, stable across every
   * call the task makes - to Atlas and to runos alike. `requestId` identifies
   * one call; only this makes a task addable up. Recorded verbatim.
   */
  taskId?: string;
}

export interface RerankScore {
  id: string;
  score: number;
}

export interface RerankResponse {
  modelCode: string;
  scores: RerankScore[];
}

/** A3.2 hard constraint - server-side validated, never silently truncated. */
export const RERANK_CANDIDATE_POOL_LIMIT = 100;
