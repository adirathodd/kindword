// Operator home (SPEC FR-1): every business with its status and location count, including self-serve sign-ups.
import { listBusinesses } from "../../operator/businesses";
import { businessListPage, requireOperator } from "../../operator/http";

export async function GET(req: Request) {
  return requireOperator(req, async () => businessListPage(await listBusinesses()));
}
