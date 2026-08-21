import { HttpException, HttpStatus } from "@nestjs/common";

export type GatewayApiKeyErrorCode =
  | "GATEWAY_API_KEY_VALIDATION_FAILED"
  | "GATEWAY_API_KEY_NOT_FOUND"
  | "GATEWAY_API_KEY_REVOKED"
  /** 409 - delete requires the key to be disabled or revoked first. */
  | "GATEWAY_API_KEY_MUST_DEACTIVATE_FIRST";

export interface GatewayApiKeyErrorResponse {
  code: GatewayApiKeyErrorCode;
  message: string;
  field?: string;
  gatewayApiKeyId?: string;
}

export class GatewayApiKeyException extends HttpException {
  constructor(
    status: HttpStatus | number,
    readonly code: GatewayApiKeyErrorCode,
    message: string,
    metadata: { field?: string; gatewayApiKeyId?: string } = {},
  ) {
    super(
      {
        code,
        message,
        ...(metadata.field !== undefined ? { field: metadata.field } : {}),
        ...(metadata.gatewayApiKeyId !== undefined
          ? { gatewayApiKeyId: metadata.gatewayApiKeyId }
          : {}),
      } satisfies GatewayApiKeyErrorResponse,
      status,
    );
  }
}
