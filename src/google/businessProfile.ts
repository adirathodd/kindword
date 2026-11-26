// Google Business Profile client (SPEC FR-11, FR-15; Integrations: Google Business Profile API; Provider notes: Google
// OAuth). The only module that talks to the Business Profile API. Per the SPEC it exposes only "list reviews" and
// "post reply". The API has one scope (business.manage) with no read-only variant, so least privilege is enforced
// here: the token endpoint, the v4 reviews list (GET) and one review's reply (PUT) are the only calls this module
// makes, and businessProfile.test.ts fails the build if any other is requested.
// No SDK: an access token is one refresh-token grant at Google's token endpoint, a read is the v4 reviews list, and a
// post is the v4 updateReply PUT. Google keeps one reply per review and a PUT replaces it, so repeating a post with the
// same text (a retry, or a run after a crash) never creates a second reply.
// Transient failures (429, 5xx, network errors, timeouts) are retried with backoff. Errors carry the HTTP status and
// a short code only, never review content, Google's message text, the tokens or the client secret. Safe to log.
// The list response also carries averageRating and totalReviewCount; they are ignored, never returned or stored
// (SPEC: no rating averages or review counts from reviews are kept).

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVIEWS_API = "https://mybusiness.googleapis.com/v4";

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const PAGE_SIZE = 50; // the v4 maximum
export const MAX_PAGES = 50; // 2,500 reviews per location per run; far above a local business's count
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// "accounts/{accountId}/locations/{locationId}", as stored in locations.google_location_id.
export const GOOGLE_LOCATION_RE = /^accounts\/[0-9]{1,30}\/locations\/[0-9]{1,30}$/;
// A review ID as it goes into the reply URL path: URL-safe characters only, the length parseReview accepts.
export const GOOGLE_REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
export const MAX_REPLY_BYTES = 4096; // Google's limit for a reply (UTF-8)
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export type GoogleReview = {
  reviewId: string;
  rating: number; // 1 to 5
  comment: string | null; // null for a rating with no text
  reviewerName: string | null; // null for an anonymous reviewer
  createdAt: Date | null;
  hasReply: boolean; // the business has already replied on Google
};

export type ReviewSourceLocation = { googleLocationId: string; refreshToken: string };

// The poller's boundary (src/reviews/poll.ts). Tests use a fake.
export interface ReviewSource {
  listReviews(location: ReviewSourceLocation): Promise<GoogleReview[]>;
}

// The poster's boundary (src/reviews/post.ts). Resolves once Google has stored the reply. Tests use a fake.
export interface ReplyPoster {
  postReply(location: ReviewSourceLocation, reviewId: string, comment: string): Promise<void>;
}

// code: invalid_location (refused before any call), token_revoked (the owner revoked our access or the grant
// expired: Google answered invalid_grant; someone must reconnect), auth_failed (Google refused our OAuth client:
// fix the configuration), no_access (403, or 404 on a read: the token's user cannot read this location),
// too_many_pages, bad_response, timeout, network, http_error. Posting adds invalid_review and invalid_reply (refused
// before any call), rejected (400: Google refused this reply) and not_found (404: the review is gone, or access to the
// location was lost; Google answers both the same way).
// retryable is true for failures a later run may get past on its own.
export class GoogleReviewsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Google reviews call failed: status=${status} code=${code}`);
    this.name = "GoogleReviewsError";
  }
}

export type GoogleOAuthConfig = { clientId: string; clientSecret: string };
export type BusinessProfileOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxAttempts?: number;
};

const retryableStatus = (status: number) => status === 429 || status >= 500;
function delayFor(attempt: number, retryAfter: string | null) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(ms, MAX_DELAY_MS);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

// One review from the v4 list. Null for an entry we cannot store (no ID, or no 1-5 star rating).
export function parseReview(raw: unknown): GoogleReview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const reviewId = str(r.reviewId);
  const rating = typeof r.starRating === "string" ? STARS[r.starRating] : undefined;
  if (!reviewId || reviewId.length > 256 || !rating) return null;
  const reviewer = (r.reviewer && typeof r.reviewer === "object" ? r.reviewer : {}) as Record<string, unknown>;
  const created = str(r.createTime);
  const createdAt = created && !Number.isNaN(Date.parse(created)) ? new Date(created) : null;
  const reply = r.reviewReply as Record<string, unknown> | undefined;
  return {
    reviewId,
    rating,
    comment: str(r.comment),
    reviewerName: reviewer.isAnonymous === true ? null : str(reviewer.displayName),
    createdAt,
    hasReply: !!reply && typeof reply === "object" && str(reply.comment) !== null,
  };
}

export class BusinessProfileClient implements ReviewSource, ReplyPoster {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  // Access tokens per refresh token, for the life of this client (one poll run).
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly config: GoogleOAuthConfig,
    opts: BusinessProfileOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  }

  // Every review of the location, newest first, across all pages.
  async listReviews(location: ReviewSourceLocation): Promise<GoogleReview[]> {
    if (!GOOGLE_LOCATION_RE.test(location.googleLocationId)) throw new GoogleReviewsError(0, "invalid_location", false);
    const out: GoogleReview[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: String(PAGE_SIZE), orderBy: "updateTime desc" });
      if (pageToken) q.set("pageToken", pageToken);
      const url = `${REVIEWS_API}/${location.googleLocationId}/reviews?${q}`;
      const json = await this.getJson(url, location.refreshToken);
      const reviews = (json as { reviews?: unknown }).reviews;
      if (reviews !== undefined && !Array.isArray(reviews)) throw new GoogleReviewsError(200, "bad_response", true);
      for (const raw of reviews ?? []) {
        const r = parseReview(raw);
        if (r) out.push(r);
      }
      const next = (json as { nextPageToken?: unknown }).nextPageToken;
      pageToken = typeof next === "string" && next ? next : null;
      if (!pageToken) return out;
    }
    throw new GoogleReviewsError(200, "too_many_pages", false);
  }

  // Sets the location's reply to one review (FR-15). Only the poster calls this, and only for an owner-approved draft.
  async postReply(location: ReviewSourceLocation, reviewId: string, comment: string): Promise<void> {
    if (!GOOGLE_LOCATION_RE.test(location.googleLocationId)) throw new GoogleReviewsError(0, "invalid_location", false);
    if (!GOOGLE_REVIEW_ID_RE.test(reviewId)) throw new GoogleReviewsError(0, "invalid_review", false);
    if (!comment.trim() || Buffer.byteLength(comment, "utf8") > MAX_REPLY_BYTES)
      throw new GoogleReviewsError(0, "invalid_reply", false);
    const url = `${REVIEWS_API}/${location.googleLocationId}/reviews/${reviewId}/reply`;
    const res = await this.authorized(url, location.refreshToken, {
      method: "PUT",
      contentType: "application/json",
      body: JSON.stringify({ comment }),
    });
    if (res.status === 400) throw new GoogleReviewsError(400, "rejected", false);
    if (res.status === 403) throw new GoogleReviewsError(403, "no_access", false);
    if (res.status === 404) throw new GoogleReviewsError(404, "not_found", false);
    await this.parseJson(res);
  }

  private async getJson(url: string, refreshToken: string): Promise<object> {
    const res = await this.authorized(url, refreshToken);
    if (res.status === 403 || res.status === 404) throw new GoogleReviewsError(res.status, "no_access", false);
    return this.parseJson(res);
  }

  // One call with the location's access token. A 401 gets one fresh token and one more try, then means token_revoked.
  private async authorized(
    url: string,
    refreshToken: string,
    init: { method?: string; body?: string; contentType?: string } = {},
  ): Promise<Response> {
    const auth = async () => ({
      Authorization: `Bearer ${await this.accessToken(refreshToken)}`,
      ...(init.contentType ? { "Content-Type": init.contentType } : {}),
    });
    let res = await this.call(url, auth, init);
    if (res.status === 401) {
      // The cached token was revoked or expired early: get a new one and try once more.
      this.tokens.delete(refreshToken);
      res = await this.call(url, auth, init);
    }
    if (res.status === 401) throw new GoogleReviewsError(401, "token_revoked", false);
    return res;
  }

  // A 2xx JSON object, or the error for anything else not already handled by the caller.
  private async parseJson(res: Response): Promise<object> {
    if (!res.ok) throw new GoogleReviewsError(res.status, "http_error", retryableStatus(res.status));
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new GoogleReviewsError(res.status, "bad_response", true);
    return json;
  }

  private async accessToken(refreshToken: string): Promise<string> {
    const now = this.now().getTime();
    const cached = this.tokens.get(refreshToken);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.value;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const res = await this.call(TOKEN_URL, async () => ({ "Content-Type": "application/x-www-form-urlencoded" }), {
      method: "POST",
      body: body.toString(),
    });
    if (!res.ok && !retryableStatus(res.status)) {
      const err = (await res.json().catch(() => null)) as { error?: unknown } | null;
      // invalid_grant: the refresh token was revoked, expired or never valid. Anything else is our OAuth client.
      if (err?.error === "invalid_grant") throw new GoogleReviewsError(res.status, "token_revoked", false);
      throw new GoogleReviewsError(res.status, "auth_failed", false);
    }
    if (!res.ok) throw new GoogleReviewsError(res.status, "http_error", true);
    const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof json?.access_token !== "string" || !json.access_token)
      throw new GoogleReviewsError(res.status, "bad_response", true);
    const ttlS = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    this.tokens.set(refreshToken, { value: json.access_token, expiresAt: now + ttlS * 1000 });
    return json.access_token;
  }

  // One request with retries on 429, 5xx, network errors and timeouts. Returns the last response (ok or a
  // non-retryable status) or throws when every attempt failed without a usable response.
  private async call(
    url: string,
    headers: () => Promise<Record<string, string>>,
    init: { method?: string; body?: string } = {},
  ): Promise<Response> {
    let last = new GoogleReviewsError(0, "network", true);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          headers: { Accept: "application/json", ...(await headers()) },
          body: init.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        if (e instanceof GoogleReviewsError) throw e; // from getting a token for this call
        last = new GoogleReviewsError(0, e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network", true);
        if (attempt < this.maxAttempts) await this.sleep(delayFor(attempt, null));
        continue;
      }
      if (!retryableStatus(res.status)) return res;
      last = new GoogleReviewsError(res.status, "http_error", true);
      if (attempt < this.maxAttempts) await this.sleep(delayFor(attempt, res.headers.get("retry-after")));
    }
    throw last;
  }
}

// Reads GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (the OAuth client the owners grant access to).
// Throws with the name of the missing setting, never its value.
export function googleOAuthConfigFromEnv(env: Record<string, string | undefined> = process.env): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!clientId || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId))
    throw new Error("GOOGLE_OAUTH_CLIENT_ID missing or not an OAuth client ID");
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientSecret) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET missing");
  return { clientId, clientSecret };
}
