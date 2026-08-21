import {
  Body,
  Delete,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";

import { OperatorAuthGuard } from "../runtime/guards/operator-auth.guard";
import {
  toOperatorAccountUuid,
  type OperatorAuthenticatedRequest,
} from "../runtime/guards/operator-auth.guard";
import { GatewayApiKeyService } from "./gateway-api-key.service";
import type {
  CreateGatewayApiKeyBody,
  GatewayApiKeyAdminRecord,
  GatewayApiKeySecretResult,
} from "./gateway-api-key.types";

// CRUD/lifecycle for keys that authenticate callers of the Atlas gateway -
// distinct from provider-keys/ (credentials Atlas presents outward). Same
// OperatorAuthGuard shape as provider-keys/provider-key.controller.ts - see
// the note there for why both the step-up criterion and the ceremony belong
// to platform/opera-bff rather than to a provider. Every write lands in
// `audit.change_records`.
@Controller("capability/api-keys")
@UseGuards(OperatorAuthGuard)
export class GatewayApiKeyController {
  constructor(
    @Inject(GatewayApiKeyService)
    private readonly keys: GatewayApiKeyService,
  ) {}

  @Get()
  list(): Promise<GatewayApiKeyAdminRecord[]> {
    return this.keys.list();
  }

  @Post()
  create(
    @Body() body: CreateGatewayApiKeyBody,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<GatewayApiKeySecretResult> {
    return this.keys.create(body, toOperatorAccountUuid(req.operatorAuth?.operatorId));
  }

  @Post(":gatewayApiKeyId/rotate")
  rotate(
    @Param("gatewayApiKeyId") gatewayApiKeyId: string,
    @Body() body: { expiresAt?: string | null },
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<GatewayApiKeySecretResult> {
    return this.keys.rotate(
      gatewayApiKeyId,
      toOperatorAccountUuid(req.operatorAuth?.operatorId),
      body?.expiresAt,
    );
  }

  /**
   * Soft delete. Requires the key to be disabled or revoked first - nothing
   * goes from live to gone in one action, matching every other resource.
   */
  @Delete(":gatewayApiKeyId")
  remove(
    @Param("gatewayApiKeyId") gatewayApiKeyId: string,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<GatewayApiKeyAdminRecord> {
    return this.keys.remove(gatewayApiKeyId, toOperatorAccountUuid(req.operatorAuth?.operatorId));
  }

  @Post(":gatewayApiKeyId/activate")
  activate(
    @Param("gatewayApiKeyId") gatewayApiKeyId: string,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<GatewayApiKeyAdminRecord> {
    return this.keys.setState(
      gatewayApiKeyId,
      "active",
      toOperatorAccountUuid(req.operatorAuth?.operatorId),
    );
  }

  @Post(":gatewayApiKeyId/deactivate")
  deactivate(
    @Param("gatewayApiKeyId") gatewayApiKeyId: string,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<GatewayApiKeyAdminRecord> {
    return this.keys.setState(
      gatewayApiKeyId,
      "inactive",
      toOperatorAccountUuid(req.operatorAuth?.operatorId),
    );
  }

  @Post(":gatewayApiKeyId/revoke")
  revoke(
    @Param("gatewayApiKeyId") gatewayApiKeyId: string,
    @Req() req: OperatorAuthenticatedRequest,
  ): Promise<GatewayApiKeyAdminRecord> {
    return this.keys.setState(
      gatewayApiKeyId,
      "revoked",
      toOperatorAccountUuid(req.operatorAuth?.operatorId),
    );
  }
}
