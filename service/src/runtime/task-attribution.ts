import { HttpStatus } from "@nestjs/common";

import { ModelRuntimeException } from "./runtime.errors";

/**
 * task-attribution.ts - `taskId` is required on every `/v1` call.
 *
 * product_251 X-2. One agent task fans out across several vxture products and
 * several models; `taskId` is the only key that totals it back up. Atlas is the
 * sole inference-metering entry point for every other product, so if it is
 * missing here it is missing everywhere - there is no second place to recover
 * it from.
 *
 * Optional was the wrong shape, and not because the clause says MUST. An
 * optional attribution key produces a total that is silently incomplete: the
 * rollup returns a number, the number looks reasonable, and the calls without a
 * key are simply absent from it. That is the same failure as the `tenantId`
 * NULL trap (#198 section 4) - traffic visible on one axis and missing from
 * another, with nothing raised - and it is the failure this repo keeps paying
 * for.
 *
 * On the stated precondition. `docs/40-implementation/40-l1-api-conformance.md`
 * said this waited on karda and vxtpl adopting the field. That was circular:
 * neither had been asked to send it, and neither would start sending a field
 * nothing required and nobody had raised. Waiting on adoption was waiting on a
 * cause that did not exist. The order is ask, then require - not observe, then
 * require. The asking is `vxture-karda`#101 / `vxture-vxtpl`#..., see the
 * conformance doc.
 *
 * A rejection here is counted. All four surfaces validate inside
 * `countingRejections`, so `model_request_rejections_total{code,product}`
 * answers "who is still not sending it" from `/metrics` - which matters
 * because a refusal happens before anything is logged, so reqlog cannot answer
 * it by construction.
 */
export function requireTaskId(taskId: string | undefined): void {
  if (taskId !== undefined && taskId.trim() !== "") return;

  throw new ModelRuntimeException(
    HttpStatus.BAD_REQUEST,
    "TASK_ID_REQUIRED",
    "taskId is required on every /v1 call (product_251 X-2). Send the id of " +
      "the agent task this call belongs to, as a top-level `taskId` on the " +
      "request body - the same value across every product and every model the " +
      "task touches, so the task can be totalled back up. Any stable string up " +
      "to 128 characters; it is stored verbatim, never coerced. If the call " +
      "belongs to no task, send the id of whatever unit of work you would want " +
      "it billed under.",
  );
}
