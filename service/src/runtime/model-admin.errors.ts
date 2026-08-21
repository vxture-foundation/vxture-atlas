/**
 * model-admin.errors.ts - Model Control Plane 结构化错误
 * @package @atlas/service
 * @layer Domain
 * @category Runtime
 *
 * @description
 *   控制面 API 对 BFF 返回稳定错误 code，避免 BFF 和 Portal 依赖异常文本。
 */

import { HttpException, HttpStatus } from "@nestjs/common";

// ============================================================================
// Types
// ============================================================================

export type ModelAdminErrorCode =
  | "MODEL_ADMIN_VALIDATION_FAILED"
  | "MODEL_ADMIN_PROVIDER_NOT_FOUND"
  | "MODEL_ADMIN_PROVIDER_CODE_TAKEN"
  | "MODEL_ADMIN_MODEL_NOT_FOUND"
  | "MODEL_ADMIN_ENDPOINT_NOT_FOUND"
  | "MODEL_ADMIN_ENDPOINT_CODE_TAKEN"
  | "MODEL_ADMIN_GRANT_NOT_FOUND"
  | "MODEL_ADMIN_PRODUCT_GRANT_NOT_FOUND"
  | "MODEL_ADMIN_POLICY_NOT_FOUND"
  | "MODEL_ADMIN_PRICE_RULE_NOT_FOUND"
  | "MODEL_ADMIN_SCOPE_INVALID"
  | "MODEL_ADMIN_NOT_IMPLEMENTED"
  | "MODEL_ADMIN_PROBE_COOLDOWN"
  /**
   * 409 - provider 存在，但名下没有可探测的启用模型。不是 404（provider 是在
   * 的），也不该静默成功：拿一个停用模型去探、然后报告 provider 健康，比不给
   * 结论更糟。
   */
  | "MODEL_ADMIN_PROVIDER_NOT_PROBEABLE"
  /**
   * 409 - the resource is still referenced. Deleting would either cascade
   * silently (the old behaviour, which revoked tenant grants nobody agreed to
   * give up) or leave a dangling reference. The response carries `blockedBy`,
   * because an operator told only "you cannot" has to go hunting for what to
   * remove.
   */
  | "MODEL_ADMIN_HAS_DEPENDENTS"
  /** 409 - must be deactivated first, so nothing goes from serving to gone in one step. */
  | "MODEL_ADMIN_MUST_DEACTIVATE_FIRST";

export interface ModelAdminErrorResponse {
  code: ModelAdminErrorCode;
  message: string;
  field?: string;
  providerId?: string;
  providerCode?: string;
  modelId?: string;
  modelCode?: string;
  endpointId?: string;
  /** MODEL_ADMIN_ENDPOINT_CODE_TAKEN - the endpoint code already in use. */
  endpointCode?: string;
  grantId?: string;
  policyId?: string;
  priceRuleId?: string;
  /** MODEL_ADMIN_PROBE_COOLDOWN (429) - 距离下一次可自检还有多久。 */
  retryAfterMs?: number;
  /** MODEL_ADMIN_HAS_DEPENDENTS (409) - what is still referencing this. */
  blockedBy?: Array<{ type: string; id: string; label: string }>;
}

// ============================================================================
// Exception
// ============================================================================

export class ModelAdminException extends HttpException {
  constructor(
    status: HttpStatus | number,
    readonly code: ModelAdminErrorCode,
    message: string,
    metadata: {
      field?: string;
      providerId?: string;
      providerCode?: string;
      modelId?: string;
      modelCode?: string;
      endpointId?: string;
      endpointCode?: string;
      grantId?: string;
      policyId?: string;
      priceRuleId?: string;
      retryAfterMs?: number;
      blockedBy?: Array<{ type: string; id: string; label: string }>;
    } = {},
  ) {
    super(
      {
        code,
        message,
        ...(metadata.field !== undefined ? { field: metadata.field } : {}),
        ...(metadata.providerId !== undefined
          ? { providerId: metadata.providerId }
          : {}),
        ...(metadata.providerCode !== undefined
          ? { providerCode: metadata.providerCode }
          : {}),
        ...(metadata.modelId !== undefined
          ? { modelId: metadata.modelId }
          : {}),
        ...(metadata.modelCode !== undefined
          ? { modelCode: metadata.modelCode }
          : {}),
        ...(metadata.endpointId !== undefined
          ? { endpointId: metadata.endpointId }
          : {}),
        ...(metadata.endpointCode !== undefined
          ? { endpointCode: metadata.endpointCode }
          : {}),
        ...(metadata.grantId !== undefined
          ? { grantId: metadata.grantId }
          : {}),
        ...(metadata.policyId !== undefined
          ? { policyId: metadata.policyId }
          : {}),
        ...(metadata.priceRuleId !== undefined
          ? { priceRuleId: metadata.priceRuleId }
          : {}),
        ...(metadata.blockedBy !== undefined
          ? { blockedBy: metadata.blockedBy }
          : {}),
        ...(metadata.retryAfterMs !== undefined
          ? { retryAfterMs: metadata.retryAfterMs }
          : {}),
      } satisfies ModelAdminErrorResponse,
      status,
    );
  }
}
