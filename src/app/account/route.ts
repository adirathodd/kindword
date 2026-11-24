// Owner account home (SPEC FR-24): business status and a button per location to open its approval inbox.
import { accountOverview, getAccountSession } from "../../accounts/accounts";
import { accountPage, accountSecret } from "../../accounts/http";
import { redirect } from "../../inbox/http";

export async function GET(req: Request) {
  const session = await getAccountSession(accountSecret(req));
  if (!session) return redirect("/account/sign-in");
  return accountPage(await accountOverview(session));
}
