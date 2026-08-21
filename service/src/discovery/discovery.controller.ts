import { Controller, Get, UseGuards } from "@nestjs/common";

import { S2sAuthGuard } from "../runtime/guards/s2s-auth.guard";
import {
  PUBLISHED_TOOL_DESCRIPTORS,
  VXTURE_TOOLS_PROTOCOL_VERSION,
} from "./tool-descriptors";
import type { VxtureToolsResponse } from "./discovery.types";

/** product_210 v1.1 §11 item 6 / §4.2 capability discovery. */
@Controller(".well-known/vxture-tools")
@UseGuards(S2sAuthGuard)
export class DiscoveryController {
  @Get()
  list(): VxtureToolsResponse {
    return {
      protocol_version: VXTURE_TOOLS_PROTOCOL_VERSION,
      tools: PUBLISHED_TOOL_DESCRIPTORS,
    };
  }
}
