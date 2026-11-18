/**
 * Operator-only policy configuration, preview and revision history.
 * @package @atlas/service
 * @layer Domain
 * @category Controller
 * @author AI-Generated
 * @date 2026-11-18
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  OperatorAuthGuard,
  type OperatorAuthenticatedRequest,
} from "../runtime/guards/operator-auth.guard";
import { ProductGrantPolicyRepository } from "./product-grant-policy.repository";
import {
  evaluatePolicy,
  PolicyValidationError,
  validatePolicyUpdate,
  validateProductCode,
} from "./product-grant-policy";

// Transport and validation ---------------------------------------------------
function checked<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PolicyValidationError)
      throw new BadRequestException({
        code: "GRANT_POLICY_INVALID",
        message: error.message,
        retryable: false,
      });
    throw error;
  }
}
@Controller("capability/product-grant-policies")
@UseGuards(OperatorAuthGuard)
export class ProductGrantPolicyController {
  constructor(
    @Inject(ProductGrantPolicyRepository)
    private readonly repository: ProductGrantPolicyRepository,
  ) {}

  @Get(":productCode")
  get(@Param("productCode") productCode: string) {
    return this.repository.get(checked(() => validateProductCode(productCode)));
  }

  @Get(":productCode/history")
  history(@Param("productCode") productCode: string) {
    return this.repository.history(
      checked(() => validateProductCode(productCode)),
    );
  }

  @Get(":productCode/effective")
  async effective(@Param("productCode") productCode: string) {
    const code = checked(() => validateProductCode(productCode));
    const document = await this.repository.get(code);
    return {
      revision: document.revision,
      ...(await this.preview(code, {
        expectedRevision: document.revision,
        rules: document.rules,
      })),
    };
  }

  @Post(":productCode/preview")
  @HttpCode(200)
  async preview(
    @Param("productCode") productCode: string,
    @Body() body: unknown,
  ) {
    checked(() => validateProductCode(productCode));
    const { rules } = checked(() => validatePolicyUpdate(body));
    const resources = await this.repository.loadResources();
    const manual = await this.repository.loadManual(productCode);
    const entries = [...evaluatePolicy(rules, resources, manual).values()];
    return {
      matched: entries.filter((entry) => entry.contributions.length > 0).length,
      denied: entries.filter((entry) => entry.deniedBy.length > 0).length,
      resources: entries.map((entry) => ({
        resourceId: entry.resourceId,
        sources: entry.contributions.map((grant) => grant.source),
        deniedBy: entry.deniedBy,
      })),
    };
  }

  @Post(":productCode")
  @HttpCode(200)
  async save(
    @Param("productCode") productCode: string,
    @Body() body: unknown,
    @Req() req: OperatorAuthenticatedRequest,
  ) {
    const code = checked(() => validateProductCode(productCode));
    const { expectedRevision, rules } = checked(() =>
      validatePolicyUpdate(body),
    );
    const document = await this.repository.save(
      code,
      expectedRevision,
      rules,
      req.operatorAuth!.operatorId,
    );

    return { ...document, propagationSeconds: 0 };
  }
}
