import type { ApplicationType, ParseTask } from "../types/runtime.types";

/** A2 parse (layout/OCR/table/formula, docs/30-design/200-s2s-provider-surface.md §3). */
export interface ParsePage {
  pageIndex: number;
  imageRef?: string;
  imageBase64?: string;
  regions?: unknown[];
}

export interface ParseRequest {
  /** Exactly one of modelCode / endpointCode / taskProfile must resolve to a model. */
  modelCode?: string;
  /**
   * Endpoint routing - see `ChatRequest.endpointCode`. The endpoint's
   * `fallbackModelCode` DOES apply here, identically to chat: all four
   * data-plane surfaces run the same `runWithS2sFailover` loop.
   */
  endpointCode?: string;
  /**
   * Task-profile routing on the LEGACY TENANT AXIS - a product wants
   * `endpointCode` above. See `ChatRequest.taskProfile` and TD-052.
   */
  taskProfile?: string;
  task: ParseTask;
  pages: ParsePage[];
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

export type { ParseTask };
