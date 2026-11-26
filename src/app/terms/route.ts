// Kindword terms, linked from the sign-up page (FR-24 records the version accepted).
import { TERMS_VERSION } from "../../accounts/accounts";
import { kindwordTermsBody } from "../../compliance/compliance";
import { html } from "../../inbox/http";

export function GET() {
  return html(200, "Kindword terms", kindwordTermsBody(TERMS_VERSION));
}
