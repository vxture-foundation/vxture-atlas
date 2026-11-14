/**
 * Resolve customer attribution from verified S2S identity only.
 * @package @atlas/service
 * @layer Domain
 * @category Runtime
 * @author AI-Generated
 * @date 2026-11-15
 */
import { isUuid } from "../uuid";
import type { S2sAuthContext } from "./guards/s2s-auth.guard";

export function endUserAttribution(auth: S2sAuthContext): { endUserId?: string } {
  if (auth.mode !== "obo" || !auth.userId) return {};
  const id = auth.userId.startsWith("usr_") ? auth.userId.slice(4) : auth.userId;
  return isUuid(id) ? { endUserId: id.trim().toLowerCase() } : {};
}
