import {
  Body,
  Delete,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { OperatorAuthGuard } from "../runtime/guards/operator-auth.guard";
import {
  toOperatorAccountUuid,
  type OperatorAuthenticatedRequest,
} from "../runtime/guards/operator-auth.guard";
import { rejectUnknownFilters } from "../http-query";
import { ProviderKeyService } from "./provider-key.service";
import type {
  CreateProviderKeyBody,
  ProviderKeyAdminRecord,
  RotateProviderKeyBody,
} from "./provider-key.types";

// See model-admin.controller.ts for the /capability naming rationale - no
// alias.
//
// Do not add step-up here: the criterion for what counts as high-stakes lives
// in the platform operator-RBAC catalogue and the ceremony is run by opera-bff
// at the moment of the action - a backend API has no UI, so it could only ever
// REFUSE, never prompt. What remains on this side is `audit.change_records`,
// which records every one of these operations with the operator `sub`.
@Controller("capability/provider-keys")
@UseGuards(OperatorAuthGuard)
export class ProviderKeyController {
  constructor(
    @Inject(ProviderKeyService) private readonly keys: ProviderKeyService,
  ) {}

  @Get()
  list(
    @Query() all: Record<string, string>,
    @Query("providerCode") providerCode?: string,
  ): Promise<ProviderKeyAdminRecord[]> {
    rejectUnknownFilters(all, ["providerCode"], "PROVIDER_KEY_UNKNOWN_FILTER");
    return this.keys.list(providerCode);
  }

  @Post()
  create(
    @Body() body: CreateProviderKeyBody,
  ): Promise<ProviderKeyAdminRecord> {
    return this.keys.create(body);
  }

  // M-5: rotatedBy comes only from the verified operator token, never the
  // body - a caller-supplied identity claim is exactly what M-5 exists to
  // stop being possible (rule 8 precedent: never trust caller-asserted
  // identity context).
  @Post(":providerKeyId/rotate")
  rotate(
    @Param("providerKeyId") providerKeyId: string,
    @Body() body: RotateProviderKeyBody,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<ProviderKeyAdminRecord> {
    const rotatedBy = toOperatorAccountUuid(req.operatorAuth?.operatorId);
    // Named copies, not `...body`: the spread forwarded whatever the client
    // sent, so a body-supplied `rotatedBy` reached the audit log unchanged
    // whenever the line above resolved to `undefined`.
    return this.keys.rotate(providerKeyId, {
      ...(body.plaintextKey !== undefined
        ? { plaintextKey: body.plaintextKey }
        : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(rotatedBy !== undefined ? { rotatedBy } : {}),
    });
  }

  @Delete(":providerKeyId")
  remove(
    @Param("providerKeyId") providerKeyId: string,
  ): Promise<ProviderKeyAdminRecord> {
    return this.keys.remove(providerKeyId);
  }

  @Post(":providerKeyId/deactivate")
  deactivate(
    @Param("providerKeyId") providerKeyId: string,
  ): Promise<ProviderKeyAdminRecord> {
    return this.keys.setActive(providerKeyId, false);
  }

  @Post(":providerKeyId/activate")
  activate(
    @Param("providerKeyId") providerKeyId: string,
  ): Promise<ProviderKeyAdminRecord> {
    return this.keys.setActive(providerKeyId, true);
  }
}
