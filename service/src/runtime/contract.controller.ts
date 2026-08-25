import { Controller, Get, UseGuards } from "@nestjs/common";

import { buildAtlasContract } from "./contract";
import { S2sAuthGuard } from "./guards/s2s-auth.guard";
import type { AtlasContract } from "./contract";

/**
 * `GET /.well-known/vxture-contract` - what this INSTANCE's `/v1` vocabulary
 * actually is (#21).
 *
 * ## Why an endpoint and not only a file
 *
 * The committed artifact (`contract/atlas-contract.json`) is what a consumer
 * vendors and pins in a test; it says what Atlas's `main` declared. This says
 * what the deployment you are calling right now declares - which is the
 * question that actually matters when a consumer is broken, and the one a
 * pinned file cannot answer. Version skew between a consumer's pinned copy and
 * the instance it calls is precisely the failure #21 exists to remove, and a
 * package alone would have re-introduced it one layer up.
 *
 * ## Same guard as everything else a consumer already calls
 *
 * `S2sAuthGuard` - the guard their `/v1/chat` calls already pass. TD-044's
 * whole lesson was that a pull channel nobody can be told to use is not a
 * channel: `.well-known/vxture-tools` was correct and reachable the entire time
 * yucer was taking 400s. Putting this behind a credential they do not have
 * would repeat that, one door further along.
 *
 * ## A new path, deliberately
 *
 * Not a field added to `.well-known/vxture-tools`: that response's shape is
 * product_210's, and extending it is a conversation. A read-only path that did
 * not exist yesterday breaks nobody and needs nobody's agreement, which is what
 * makes this half of #21 shippable now while the request/response schemas wait
 * on their own design.
 */
@Controller(".well-known/vxture-contract")
@UseGuards(S2sAuthGuard)
export class ContractController {
  @Get()
  read(): AtlasContract {
    // Computed per request rather than memoised: it is a pure function over a
    // frozen table, the table cannot change without a redeploy, and a cache
    // here would be one more thing that can be stale about a document whose
    // entire job is not being stale.
    return buildAtlasContract();
  }
}
