// FR-23 compliance pages: per-location SMS opt-in, SMS terms and privacy (the URLs that go into each client's 10DLC
// campaign), plus Kindword's own /terms and /privacy. All copy here is a DRAFT for owner review (see the PR); bump
// the version whenever the wording changes, because stored consent records point at it.
import { and, eq, ne } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { businesses, locations, smsOptIns } from "../db/schema";
import { allow } from "../accounts/accounts";
import { escapeHtml as e } from "../inbox/auth";
import { normalizePhone } from "../intake/normalize";

// Stored in sms_opt_ins.consent_wording_version (FR-3). "-draft" marks records collected under unreviewed wording.
export const OPT_IN_WORDING_VERSION = "2026-11-25-draft";
export const SMS_TERMS_VERSION = "2026-11-25.2-draft";
// Shown on every policy page; change with the versions above.
const EFFECTIVE = "November 25, 2026 (draft)";
// shortcut: placeholder until the owner picks a real support address; change it here before 10DLC submission.
export const CONTACT_EMAIL = "hello@kindword.fun";

export type Program = { locationId: string; businessId: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The pages exist from onboarding on (10DLC vetting happens before go-live) and disappear once offboarded.
export async function loadProgram(locationId: string, db: Db = defaultDb): Promise<Program | null> {
  if (!UUID.test(locationId)) return null;
  const [row] = await db
    .select({
      locationId: locations.id,
      businessId: businesses.id,
      business: businesses.name,
      location: locations.name,
    })
    .from(locations)
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .where(and(eq(locations.id, locationId), ne(businesses.status, "offboarded")));
  if (!row) return null;
  const name = row.location.trim() === row.business.trim() ? row.business : `${row.business} (${row.location})`;
  return { locationId: row.locationId, businessId: row.businessId, name };
}

export const paths = (locationId: string) => ({
  optIn: `/sms/${locationId}`,
  terms: `/sms/${locationId}/terms`,
  privacy: `/sms/${locationId}/privacy`,
});

const draftNote = `<p class="notice" role="note">Draft wording, pending review. Not final legal text.</p>`;

// The exact consent statement next to the checkbox (TCPA written-consent elements: names the business, authorizes
// texts to the number entered, says consent is not a condition of purchase). Plain text; links follow it.
export const consentStatement = (p: Program) =>
  `I agree to receive text messages from ${p.name}, sent by Kindword on its behalf, at the mobile number I entered above, asking me to review my service. Up to 2 texts per job. Messages may be sent using automated technology. Consent is not a condition of any purchase or service. Msg & data rates may apply. Reply HELP for help or STOP to opt out at any time.`;

export function optInBody(p: Program, error: string | null = null, phone = "") {
  const u = paths(p.locationId);
  return `${draftNote}${error ? `<p class="notice error" role="alert">${e(error)}</p>` : ""}<p>Sign up to get a text from ${e(
    p.name,
  )} after your job asking for a review. You do not need to sign up to get service.</p><form method="post"><p><label for="phone" class="stack">Mobile number<input id="phone" name="phone" type="tel" value="${e(
    phone,
  )}" autocomplete="tel" inputmode="tel" maxlength="30" required></label></p><p><label><input type="checkbox" name="consent" value="yes"> <span>${e(
    consentStatement(p),
  )} See the <a href="${u.terms}">SMS terms</a> and <a href="${u.privacy}">privacy policy</a>.</span></label></p><div class="row"><button type="submit" class="primary">Sign up for texts</button></div></form><p class="meta">Wording version ${OPT_IN_WORDING_VERSION}</p>`;
}

export type OptInResult = { ok: true } | { ok: false; error: string; phone: string } | { ok: false; limited: true };

// Records one consent. Refused unless the box is checked and the number is a valid US mobile-format number. Never
// logs the number. Does not lift an earlier opt-out: suppression is checked before every send (FR-8) and stays.
export async function recordOptIn(
  p: Program,
  input: { phone: string; consent: boolean },
  ip: string,
  now = new Date(),
  db: Db = defaultDb,
): Promise<OptInResult> {
  const phone = normalizePhone(input.phone.slice(0, 30));
  if (!phone) return { ok: false, error: "Enter a 10-digit US mobile number.", phone: input.phone.slice(0, 30) };
  if (!input.consent) return { ok: false, error: "Check the box to agree to texts.", phone: input.phone.slice(0, 30) };
  if (!(await allow("smsOptInIp", ip, now, db))) return { ok: false, limited: true };
  await db.insert(smsOptIns).values({
    locationId: p.locationId,
    businessId: p.businessId,
    normalizedPhone: phone,
    consentWordingVersion: OPT_IN_WORDING_VERSION,
    consentAt: now,
  });
  return { ok: true };
}

export const smsTermsBody = (p: Program) => {
  const u = paths(p.locationId);
  return `${draftNote}<h2>Program</h2><p>${e(
    p.name,
  )} review requests. After a job, ${e(p.name)} may send you a text with a link to leave a Google review. Kindword sends these texts on behalf of ${e(
    p.name,
  )}. Every customer who signs up is asked the same way; the texts carry no offers or incentives.</p><h2>Message frequency</h2><p>Up to 2 texts per job: one review request and, if you have not opened the link, one reminder about 3 days later. Texts are sent only between 9 a.m. and 8 p.m. local time.</p><h2>Cost</h2><p>Msg &amp; data rates may apply. Carriers are not liable for delayed or undelivered messages.</p><h2>Help</h2><p>Reply HELP to any text for help, or email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p><h2>Opting out</h2><p>Reply STOP to any text to stop all texts from this program. REVOKE, OPT OUT, CANCEL, UNSUBSCRIBE, END and QUIT also work. You get one text confirming the opt-out and nothing after that, for this business and every business Kindword texts for.</p><h2>Consent</h2><p>Signing up is not a condition of any purchase or service. Sign up on the <a href="${u.optIn}">opt-in page</a>.</p><h2>Privacy</h2><p>We never share your mobile number or consent for marketing. See the <a href="${u.privacy}">privacy policy</a>.</p><h2>Changes</h2><p>If these terms change, we post the new version here. Effective ${EFFECTIVE}.</p><p class="meta">Version ${SMS_TERMS_VERSION}</p>`;
};

// Carrier vetting (Twilio 30908) reads the privacy policy for this: mobile data and SMS consent are never shared for
// marketing, and no other sentence on the page may contradict it. Same clause on both policies.
const SMS_SHARING = `No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties. The only exception is the service providers that deliver the texts for us (our SMS carrier, Twilio), which may use the data only to send messages for this program.`;

export const smsPrivacyBody = (p: Program) => {
  const u = paths(p.locationId);
  return `${draftNote}<p>This policy covers the ${e(p.name)} review request text program, which Kindword runs on behalf of ${e(
    p.name,
  )}. Effective ${EFFECTIVE}.</p><h2>What we collect</h2><ul><li>Your mobile number and, if you give it, your email address and name.</li><li>Your consent: when you gave it, how (for example this <a href="${u.optIn}">opt-in page</a> or a signed estimate) and the wording you agreed to.</li><li>The texts we sent you, whether you opened the review link, and any opt-out.</li></ul><h2>How we use it</h2><p>Only to send the review request and the one reminder described in the <a href="${u.terms}">SMS terms</a>, and to honor opt-outs. Up to 2 texts per job. Msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.</p><h2>Sharing</h2><p>${SMS_SHARING}</p><p>We never sell personal information. We disclose it only when the law requires it, for example to answer a valid subpoena.</p><h2>How long we keep it</h2><p>While ${e(
    p.name,
  )} uses Kindword. When it stops, or when you ask, we delete your contact details. We keep a record of an opt-out so we never text you again.</p><h2>Security</h2><p>Your number is stored in an access-controlled database and kept out of our logs. Our pages use HTTPS.</p><h2>Your choices</h2><p>Reply STOP to any text to opt out. To see, correct or delete what we hold about you, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. We answer within 45 days. If we refuse a request you can ask us to reconsider by replying to our answer.</p><h2>Changes</h2><p>If this policy changes, we post the new version here with a new effective date. We never use your number in a new way without asking for your consent again.</p><p class="meta">Version ${SMS_TERMS_VERSION}</p>`;
};

// Kindword's own terms and privacy policy, accepted at sign-up (FR-24 records TERMS_VERSION). Built from the SPEC's
// "Contract terms to put in place before the first customer" plus the usual SaaS clauses (liability, law, changes);
// the signed service agreement governs where it differs.
export const kindwordTermsBody = (version: string) =>
  `${draftNote}<p>These terms are an agreement between you, the business owner, and Kindword. They cover the Kindword service: review requests sent to your customers by text or email, AI-drafted replies to your Google reviews for you to approve, and a monthly report. Effective ${EFFECTIVE}. By creating an account you agree to them; if you sign a service agreement with us, it controls where it differs.</p><h2>Eligibility</h2><p>You must be at least 18 and authorized to act for the business you sign up.</p><h2>Fees</h2><p>Fees and billing are set in your service agreement or order. Nothing is charged before your business is switched to live.</p><h2>Your customers' consent</h2><ul><li>You tell us in writing how each customer list captured consent to texts, and you keep those consent records.</li><li>For new customers you use our consent wording or your hosted opt-in page.</li><li>You give us only contact details you are allowed to share, and you are responsible for the consent records you supply.</li><li>Customers without a written-consent record get email only. We may pause texting if records are missing.</li></ul><h2>Review requests</h2><p>Every eligible customer is asked the same way. We never filter by expected rating, offer incentives, name staff or ask for specific content, and you agree not to ask us to. A customer who opts out is never texted again, for your business or any other.</p><h2>Replies</h2><p>Replies are drafted with AI. Nothing is posted until you approve it, and you are responsible for the replies you approve. You authorize us in writing to access your Google Business Profile and to post the replies you approve, and you can revoke that at any time. Google access uses your own grant; we never ask for your password.</p><h2>Acceptable use</h2><p>Don't use the service to send messages to people who have not consented, to send anything other than review requests, to break Google's, carriers' or any other rules or laws, or to interfere with the service.</p><h2>No guarantees</h2><p>We do not promise a number of reviews or a star rating. The service is provided as is. Google, carriers and email providers can delay or block messages and replies, and we are not responsible for their decisions.</p><h2>Limitation of liability</h2><p>To the extent the law allows, neither side is liable for indirect or consequential losses, and our total liability is limited to the fees you paid us in the 12 months before the claim.</p><h2>Changes and cancellation</h2><ul><li>Month to month. Either side can cancel with 30 days' notice. We may suspend the service at once if it is being used against these terms.</li><li>We give 48 hours' notice of changes that affect your profile, and 30 days' notice by email of changes to these terms.</li><li>We remove our Google access within 7 business days of cancellation and delete your customer data on request.</li></ul><h2>Your account</h2><p>Keep your password private and tell us if you think someone else has used your account. Nothing is imported or sent until we finish setup with you and switch your business to live.</p><h2>Governing law</h2><p>These terms are governed by the laws of the State of New Jersey.</p><h2>Contact</h2><p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p><p class="meta">Version ${e(version)}</p>`;

export const kindwordPrivacyBody = (version: string) =>
  `${draftNote}<p>This policy covers Kindword's website and service. Effective ${EFFECTIVE}. Each business we text for also has its own SMS privacy page, linked from its opt-in page; both say the same about text messaging data.</p><h2>What we collect</h2><ul><li>Business owners: name, business name, email, a hashed password, the terms version you accepted, and sign-in records.</li><li>Your customers, from the lists you give us or from an opt-in page: name, mobile number, email, visit time and their consent record, plus the messages we sent, link clicks and opt-outs.</li><li>Google reviews of your business: review text, reviewer name and rating, and the reply drafts we make from them.</li><li>Waitlist requests: name, business, email and Google Maps link.</li></ul><h2>How we use it</h2><p>Only to run the service for the business the data belongs to: send review requests and the one reminder (up to 2 texts per job; Msg &amp; data rates may apply; reply HELP for help, STOP to opt out), honor opt-outs, draft replies for approval, and build your monthly report. One business's data is never used for another, and we do not use it to train AI models.</p><h2>Sharing</h2><p>${SMS_SHARING}</p><p>We never sell personal data and do not use it for targeted advertising. Other service providers process data only to run the service: Resend (email), Google (reviews and replies), our hosting and database providers, and an AI provider that drafts replies from review text and never receives phone numbers. We disclose information only when the law requires it.</p><h2>How long we keep it</h2><ul><li>Review text, reviewer names and reply drafts: deleted within 30 days of fetching.</li><li>Customer contact details: while the business uses Kindword, and deleted on request or when it leaves. Opt-out records are kept so we never contact that person again.</li><li>Owner accounts: until you close your account.</li></ul><h2>Cookies</h2><p>We use only the cookies that keep you signed in. No advertising or analytics trackers. Because we do not track you across sites, we treat browser Do Not Track signals the same as no signal.</p><h2>Security</h2><p>Passwords are stored only as salted hashes. Google access tokens are encrypted. Our site uses HTTPS. Phone numbers, message text and review text are kept out of our logs.</p><h2>Your rights</h2><p>You can ask to see, correct, delete or get a copy of your data. Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. We answer within 45 days, and if we refuse you can appeal by replying to our answer. If you are a business's customer, we may pass your request to that business, which decides with us.</p><h2>Children</h2><p>The service is for businesses and is not directed to children under 13. We do not knowingly collect their data.</p><h2>Changes</h2><p>We post changes here with a new effective date and email account owners about material changes.</p><p class="meta">Version ${e(version)}</p>`;
