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
export const SMS_TERMS_VERSION = "2026-11-25-draft";
// shortcut: placeholder until the owner picks a real support address; change it here before 10DLC submission.
export const CONTACT_EMAIL = "hello@kindword.example";

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
  )}. Every customer who signs up is asked the same way; the texts carry no offers or incentives.</p><h2>Message frequency</h2><p>Up to 2 texts per job: one review request and, if you have not opened the link, one reminder about 3 days later. Texts are sent only between 9 a.m. and 8 p.m. local time.</p><h2>Cost</h2><p>Msg &amp; data rates may apply. Carriers are not liable for delayed or undelivered messages.</p><h2>Help</h2><p>Reply HELP to any text for help, or email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p><h2>Opting out</h2><p>Reply STOP to any text to stop all texts from this program. REVOKE, OPT OUT, CANCEL, UNSUBSCRIBE, END and QUIT also work. You get one text confirming the opt-out and nothing after that, for this business and every business Kindword texts for.</p><h2>Consent</h2><p>Signing up is not a condition of any purchase or service. Sign up on the <a href="${u.optIn}">opt-in page</a>.</p><h2>Privacy</h2><p>See the <a href="${u.privacy}">privacy policy</a>.</p><p class="meta">Version ${SMS_TERMS_VERSION}</p>`;
};

export const smsPrivacyBody = (p: Program) => {
  const u = paths(p.locationId);
  return `${draftNote}<p>This policy covers the ${e(p.name)} review request text program, which Kindword runs on behalf of ${e(
    p.name,
  )}.</p><h2>What we collect</h2><ul><li>Your mobile number and, if you give it, your email address and name.</li><li>Your consent: when you gave it, how (for example this <a href="${u.optIn}">opt-in page</a> or a signed estimate) and the wording you agreed to.</li><li>The texts we sent you, whether you opened the review link, and any opt-out.</li></ul><h2>How we use it</h2><p>Only to send the review request and the one reminder described in the <a href="${u.terms}">SMS terms</a>, and to honor opt-outs.</p><h2>Sharing</h2><p>We never sell, rent or share mobile numbers or SMS consent with third parties or affiliates for their marketing or promotional purposes. Our texting provider (Twilio) carries the messages for us and may not use them for anything else. We disclose information only when the law requires it.</p><h2>How long we keep it</h2><p>While ${e(
    p.name,
  )} uses Kindword. When it stops, or when you ask, we delete your contact details. We keep a record of an opt-out so we never text you again.</p><h2>Contact</h2><p>To ask what we hold about you or to have it deleted, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Reply STOP to any text to opt out.</p><p class="meta">Version ${SMS_TERMS_VERSION}</p>`;
};

// Kindword's own terms and privacy policy, accepted at sign-up (FR-24 records TERMS_VERSION). Built from the SPEC's
// "Contract terms to put in place before the first customer"; the signed service agreement governs where it differs.
export const kindwordTermsBody = (version: string) =>
  `${draftNote}<p>These terms cover the Kindword service for business owners. Kindword sends review requests to your customers by text or email, drafts replies to your Google reviews for you to approve, and emails you a monthly report.</p><h2>Your customers' consent</h2><ul><li>You tell us in writing how each customer list captured consent to texts, and you keep those consent records.</li><li>For new customers you use our consent wording or your hosted opt-in page.</li><li>Customers without a written-consent record get email only. We may pause texting if records are missing.</li></ul><h2>Review requests</h2><p>Every eligible customer is asked the same way. We never filter by expected rating, offer incentives, name staff or ask for specific content. A customer who opts out is never texted again, for your business or any other.</p><h2>Replies</h2><p>Replies are drafted with AI. Nothing is posted until you approve it. You authorize us in writing to access your Google Business Profile and to post the replies you approve, and you can revoke that at any time. Google access uses your own grant; we never ask for your password.</p><h2>No guarantees</h2><p>We do not promise a number of reviews or a star rating.</p><h2>Changes and cancellation</h2><ul><li>Month to month. Either side can cancel with 30 days' notice.</li><li>We give 48 hours' notice of changes that affect your profile.</li><li>We remove our Google access within 7 business days of cancellation and delete your customer data on request.</li></ul><h2>Your account</h2><p>Keep your password private. Nothing is imported or sent until we finish setup with you and switch your business to live.</p><h2>Contact</h2><p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p><p class="meta">Version ${e(version)}</p>`;

export const kindwordPrivacyBody = (version: string) =>
  `${draftNote}<p>This policy covers Kindword's website and service. Each business we text for also has its own SMS privacy page, linked from its opt-in page.</p><h2>What we collect</h2><ul><li>Business owners: name, business name, email, a hashed password, the terms version you accepted, and sign-in records.</li><li>Your customers, from the lists you give us: name, mobile number, email, visit time and their consent record, plus the messages we sent, link clicks and opt-outs.</li><li>Google reviews of your business: review text, reviewer name and rating, and the reply drafts we make from them.</li></ul><h2>How we use it</h2><p>Only to run the service for the business the data belongs to: send review requests, honor opt-outs, draft replies for approval, and build your monthly report. One business's data is never used for another.</p><h2>Sharing</h2><p>We never sell personal data. We never sell, rent or share mobile numbers or SMS consent with third parties or affiliates for their marketing or promotional purposes. Service providers process data only to run the service: Twilio (texts), Resend (email), Google (reviews and replies), our hosting and database providers, and an AI provider that drafts replies from review text. We disclose information only when the law requires it.</p><h2>How long we keep it</h2><ul><li>Review text, reviewer names and reply drafts: deleted within 30 days of fetching.</li><li>Customer contact details: while the business uses Kindword, and deleted on request or when it leaves. Opt-out records are kept so we never contact that person again.</li><li>Owner accounts: until you close your account.</li></ul><h2>Security</h2><p>Passwords are stored only as salted hashes. Google access tokens are encrypted. Phone numbers, message text and review text are kept out of our logs.</p><h2>Contact</h2><p>To see or delete what we hold about you, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p><p class="meta">Version ${e(version)}</p>`;
