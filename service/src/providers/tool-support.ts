import { HttpStatus } from "@nestjs/common";

import { ModelRuntimeException } from "../runtime/runtime.errors";
import type { ProviderChatRequest } from "../types/runtime.types";
import type { ResolvedWire } from "./wire";

type ToolRequest = Pick<ProviderChatRequest, "tools" | "toolChoice" | "messages">;

/** Includes continuation turns whose caller no longer sends definitions. */
export function supportsToolRequest(wire: ResolvedWire, request: ToolRequest): boolean {
  const needsTools = Boolean(request.tools?.length) || request.messages.some(
    (message) => message.role === "tool" || Boolean(message.toolCalls?.length),
  );
  return (!needsTools || wire.supports.tools) &&
    (request.toolChoice === undefined || wire.supports.toolChoice);
}

/** Defense at the adapter seam as well as candidate selection. */
export function assertToolSupport(wire: ResolvedWire, request: ToolRequest): void {
  if (!supportsToolRequest(wire, request)) {
    throw new ModelRuntimeException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "TOOL_CALLING_UNSUPPORTED",
      "The model cannot honor this request's tools, tool history or toolChoice",
    );
  }
}
