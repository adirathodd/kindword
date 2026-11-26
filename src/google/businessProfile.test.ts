// No network: every call goes to a fake fetch. Fake data only.
import { describe, expect, it } from "vitest";
import {
  BusinessProfileClient,
  GoogleReviewsError,
  MAX_PAGES,
  REVIEWS_API,
  TOKEN_URL,
  googleOAuthConfigFromEnv,
  parseReview,
} from "./businessProfile";

const LOC = "accounts/123/locations/456";
const CONFIG = { clientId: "cid.apps.googleusercontent.com", clientSecret: "test-client-secret" };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeFetch(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(c);
    return handler(c, calls.length);
  }) as typeof fetch;
  return { impl, calls };
}

const review = (id: string, extra: Record<string, unknown> = {}) => ({
  reviewId: id,
  starRating: "FOUR",
  comment: "Fixed the leak.",
  reviewer: { displayName: "Pat Example" },
  createTime: "2026-11-20T15:00:00Z",
  ...extra,
});

// Token grant, then the reviews list pages given.
function google(pages: unknown[][], opts: { tokenStatus?: number; tokenBody?: unknown } = {}) {
  let page = 0;
  return fakeFetch((c) => {
    if (c.url === TOKEN_URL)
      return json(opts.tokenStatus ?? 200, opts.tokenBody ?? { access_token: "at-1", expires_in: 3600 });
    const p = page++;
    return json(200, {
      reviews: pages[p],
      averageRating: 4.2,
      totalReviewCount: 99,
      ...(p < pages.length - 1 ? { nextPageToken: `t${p + 1}` } : {}),
    });
  });
}

const client = (impl: typeof fetch, extra = {}) =>
  new BusinessProfileClient(CONFIG, { fetchImpl: impl, sleep: async () => {}, ...extra });

describe("parseReview", () => {
  it("maps Google's fields and drops entries we cannot store", () => {
    expect(parseReview(review("r1", { reviewReply: { comment: "Thanks!" } }))).toEqual({
      reviewId: "r1",
      rating: 4,
      comment: "Fixed the leak.",
      reviewerName: "Pat Example",
      createdAt: new Date("2026-11-20T15:00:00Z"),
      hasReply: true,
    });
    expect(
      parseReview(review("r2", { comment: undefined, reviewer: { displayName: "A", isAnonymous: true } })),
    ).toMatchObject({ comment: null, reviewerName: null, hasReply: false });
    expect(parseReview(review("r3", { starRating: "STAR_RATING_UNSPECIFIED" }))).toBeNull();
    expect(parseReview(review("", {}))).toBeNull();
    expect(parseReview(null)).toBeNull();
    expect(parseReview(review("r4", { createTime: "not a date" }))?.createdAt).toBeNull();
  });
});

describe("BusinessProfileClient.listReviews", () => {
  it("gets an access token from the refresh token and reads every page", async () => {
    const g = google([[review("a"), review("b")], [review("c")]]);
    const out = await client(g.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt-secret" });
    expect(out.map((r) => r.reviewId)).toEqual(["a", "b", "c"]);
    expect(out[0]).not.toHaveProperty("averageRating");

    const [token, p1, p2] = g.calls;
    expect(token).toMatchObject({ url: TOKEN_URL, method: "POST" });
    expect(new URLSearchParams(token.body)).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "rt-secret",
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
      }),
    );
    expect(p1.url).toBe(`${REVIEWS_API}/${LOC}/reviews?pageSize=50&orderBy=updateTime+desc`);
    expect(p1.headers.Authorization).toBe("Bearer at-1");
    expect(p2.url).toContain("pageToken=t1");
    expect(g.calls).toHaveLength(3); // one token for the whole run
  });

  it("calls only Google's token endpoint and the v4 reviews list (least privilege)", async () => {
    const g = google([[review("a")], [review("b")]]);
    const c = client(g.impl);
    await c.listReviews({ googleLocationId: LOC, refreshToken: "rt" });
    await c.listReviews({ googleLocationId: "accounts/9/locations/8", refreshToken: "rt2" }).catch(() => {});
    const allowed = [
      (u: string) => u === TOKEN_URL,
      (u: string) => /^https:\/\/mybusiness\.googleapis\.com\/v4\/accounts\/\d+\/locations\/\d+\/reviews\?/.test(u),
    ];
    for (const call of g.calls)
      expect(
        allowed.some((ok) => ok(call.url)),
        call.url,
      ).toBe(true);
    for (const call of g.calls.filter((x) => x.url !== TOKEN_URL)) expect(call.method).toBe("GET");
  });

  it("refuses a malformed location ID before calling Google", async () => {
    const g = google([[]]);
    for (const id of ["accounts/1/locations/2/../../x", "locations/2", "accounts/1/locations/2?x=1", ""])
      await expect(client(g.impl).listReviews({ googleLocationId: id, refreshToken: "rt" })).rejects.toMatchObject({
        code: "invalid_location",
      });
    expect(g.calls).toHaveLength(0);
  });

  it("returns an empty list for a location with no reviews", async () => {
    const g = fakeFetch((c) => (c.url === TOKEN_URL ? json(200, { access_token: "at" }) : json(200, {})));
    expect(await client(g.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).toEqual([]);
  });

  it("reports a revoked grant as token_revoked and other token refusals as auth_failed", async () => {
    const revoked = google([[]], { tokenStatus: 400, tokenBody: { error: "invalid_grant" } });
    await expect(client(revoked.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).rejects.toMatchObject(
      { code: "token_revoked", retryable: false },
    );
    const badClient = google([[]], { tokenStatus: 401, tokenBody: { error: "invalid_client" } });
    await expect(
      client(badClient.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" }),
    ).rejects.toMatchObject({ code: "auth_failed", retryable: false });
  });

  it("gets a new token once on a 401, then gives up as token_revoked", async () => {
    let tokens = 0;
    const g = fakeFetch((c) => {
      if (c.url === TOKEN_URL) return json(200, { access_token: `at-${++tokens}` });
      return c.headers.Authorization === "Bearer at-1" ? json(401, {}) : json(200, { reviews: [review("a")] });
    });
    expect(await client(g.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).toHaveLength(1);
    expect(tokens).toBe(2);

    const always401 = fakeFetch((c) => (c.url === TOKEN_URL ? json(200, { access_token: "at" }) : json(401, {})));
    await expect(
      client(always401.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" }),
    ).rejects.toMatchObject({ code: "token_revoked" });
  });

  it("maps 403 and 404 to no_access", async () => {
    for (const status of [403, 404]) {
      const g = fakeFetch((c) => (c.url === TOKEN_URL ? json(200, { access_token: "at" }) : json(status, {})));
      await expect(client(g.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).rejects.toMatchObject({
        code: "no_access",
        status,
      });
    }
  });

  it("retries 429, 5xx and network errors with backoff, honoring Retry-After", async () => {
    const sleeps: number[] = [];
    const g = fakeFetch((c, n) => {
      if (c.url === TOKEN_URL) return json(200, { access_token: "at" });
      if (n === 2) return json(429, {}, { "Retry-After": "2" });
      if (n === 3) throw new TypeError("fetch failed");
      return json(200, { reviews: [review("a")] });
    });
    const out = await client(g.impl, { sleep: async (ms: number) => void sleeps.push(ms) }).listReviews({
      googleLocationId: LOC,
      refreshToken: "rt",
    });
    expect(out).toHaveLength(1);
    expect(sleeps).toEqual([2000, 1000]);

    const down = fakeFetch((c) => (c.url === TOKEN_URL ? json(200, { access_token: "at" }) : json(503, {})));
    await expect(client(down.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).rejects.toMatchObject({
      code: "http_error",
      status: 503,
      retryable: true,
    });
  });

  it("refuses a bad response shape and stops after MAX_PAGES", async () => {
    const bad = fakeFetch((c) => (c.url === TOKEN_URL ? json(200, { access_token: "at" }) : json(200, { reviews: 3 })));
    await expect(client(bad.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).rejects.toMatchObject({
      code: "bad_response",
    });
    const endless = fakeFetch((c) =>
      c.url === TOKEN_URL ? json(200, { access_token: "at" }) : json(200, { reviews: [], nextPageToken: "again" }),
    );
    await expect(client(endless.impl).listReviews({ googleLocationId: LOC, refreshToken: "rt" })).rejects.toMatchObject(
      { code: "too_many_pages" },
    );
    expect(endless.calls).toHaveLength(MAX_PAGES + 1);
  });

  it("never puts review text, tokens or the client secret in an error", async () => {
    const g = fakeFetch((c) =>
      c.url === TOKEN_URL
        ? json(400, { error: "invalid_grant", error_description: "Token rt-secret bad; Fixed the leak." })
        : json(200, {}),
    );
    const err = (await client(g.impl)
      .listReviews({ googleLocationId: LOC, refreshToken: "rt-secret" })
      .catch((e) => e)) as GoogleReviewsError;
    expect(err).toBeInstanceOf(GoogleReviewsError);
    expect(`${err.message} ${err.stack}`).not.toMatch(/rt-secret|test-client-secret|leak/);
  });
});

describe("BusinessProfileClient.postReply (FR-15)", () => {
  const REVIEW_ID = "AbC-12_x";
  const replyUrl = `${REVIEWS_API}/${LOC}/reviews/${REVIEW_ID}/reply`;
  // Token grant, then the given responses for the reply call in order (the last one repeats).
  function poster(...responses: (() => Response)[]) {
    let n = 0;
    return fakeFetch((c) =>
      c.url === TOKEN_URL
        ? json(200, { access_token: "at-1", expires_in: 3600 })
        : responses[Math.min(n++, responses.length - 1)](),
    );
  }
  const ok = () => json(200, { comment: "Thanks!", updateTime: "2026-11-26T10:00:00Z" });
  const post = (impl: typeof fetch, over: { location?: string; reviewId?: string; comment?: string } = {}) =>
    client(impl).postReply(
      { googleLocationId: over.location ?? LOC, refreshToken: "rt" },
      over.reviewId ?? REVIEW_ID,
      over.comment ?? "Thanks for choosing us!",
    );

  it("PUTs the reply text to the review's v4 reply endpoint", async () => {
    const g = poster(ok);
    await post(g.impl);
    const put = g.calls.find((c) => c.url !== TOKEN_URL)!;
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(replyUrl);
    expect(put.headers.Authorization).toBe("Bearer at-1");
    expect(put.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(put.body!)).toEqual({ comment: "Thanks for choosing us!" });
  });

  it("retries a transient failure (the reply PUT is idempotent: Google keeps one reply per review)", async () => {
    const g = poster(
      () => json(503, {}),
      () => json(429, {}),
      ok,
    );
    await post(g.impl);
    expect(g.calls.filter((c) => c.url === replyUrl)).toHaveLength(3);
  });

  it("maps Google's answers to safe codes", async () => {
    const cases: [() => Response, string, boolean][] = [
      [() => json(400, { error: { message: "Thanks for choosing us!" } }), "rejected", false],
      [() => json(403, {}), "no_access", false],
      [() => json(404, {}), "not_found", false],
      [() => json(401, {}), "token_revoked", false],
      [() => json(500, {}), "http_error", true],
      [() => new Response("not json", { status: 200 }), "bad_response", true],
    ];
    for (const [res, code, retryable] of cases)
      await expect(post(poster(res).impl)).rejects.toMatchObject({ code, retryable });
  });

  it("reports a revoked grant as token_revoked", async () => {
    const g = fakeFetch((c) => (c.url === TOKEN_URL ? json(400, { error: "invalid_grant" }) : ok()));
    await expect(post(g.impl)).rejects.toMatchObject({ code: "token_revoked", retryable: false });
    expect(g.calls.every((c) => c.url === TOKEN_URL)).toBe(true);
  });

  it("refuses a bad location, review ID or reply text before calling Google", async () => {
    const g = poster(ok);
    for (const location of ["accounts/1/locations/2/../../x", "locations/2", ""])
      await expect(post(g.impl, { location })).rejects.toMatchObject({ code: "invalid_location", retryable: false });
    for (const reviewId of ["", "a/b", "../x", "a?b", "a b", "x".repeat(257)])
      await expect(post(g.impl, { reviewId })).rejects.toMatchObject({ code: "invalid_review", retryable: false });
    for (const comment of ["", "   ", "é".repeat(2049)])
      // 2,049 two-byte characters is over 4,096 bytes
      await expect(post(g.impl, { comment })).rejects.toMatchObject({ code: "invalid_reply", retryable: false });
    expect(g.calls).toHaveLength(0);
  });

  it("accepts a reply of exactly 4,096 bytes", async () => {
    const g = poster(ok);
    await post(g.impl, { comment: "é".repeat(2048) });
    expect(g.calls.filter((c) => c.url === replyUrl)).toHaveLength(1);
  });

  it("never puts the reply text, tokens or the client secret in an error", async () => {
    const g = poster(() => json(400, { error: { message: "Thanks for choosing us! rt test-client-secret" } }));
    const err = (await post(g.impl).catch((e) => e)) as GoogleReviewsError;
    expect(err).toBeInstanceOf(GoogleReviewsError);
    expect(`${err.message} ${err.stack}`).not.toMatch(/Thanks for choosing|test-client-secret|at-1/);
  });

  it("calls only the token endpoint, the v4 reviews list (GET) and a review's reply (PUT) (least privilege)", async () => {
    const g = fakeFetch((c) => {
      if (c.url === TOKEN_URL) return json(200, { access_token: "at", expires_in: 3600 });
      return c.method === "PUT" ? ok() : json(200, { reviews: [review("a")] });
    });
    const c = client(g.impl);
    await c.listReviews({ googleLocationId: LOC, refreshToken: "rt" });
    await c.postReply({ googleLocationId: LOC, refreshToken: "rt" }, "a", "Thanks!");
    const list = /^https:\/\/mybusiness\.googleapis\.com\/v4\/accounts\/\d+\/locations\/\d+\/reviews\?/;
    const reply = /^https:\/\/mybusiness\.googleapis\.com\/v4\/accounts\/\d+\/locations\/\d+\/reviews\/[\w-]+\/reply$/;
    for (const call of g.calls) {
      const allowed =
        (call.url === TOKEN_URL && call.method === "POST") ||
        (list.test(call.url) && call.method === "GET") ||
        (reply.test(call.url) && call.method === "PUT");
      expect(allowed, `${call.method} ${call.url}`).toBe(true);
    }
    expect(g.calls.some((x) => x.method === "PUT")).toBe(true);
  });
});

describe("googleOAuthConfigFromEnv", () => {
  it("reads the OAuth client and names what is missing without echoing values", () => {
    expect(
      googleOAuthConfigFromEnv({
        GOOGLE_OAUTH_CLIENT_ID: " cid.apps.googleusercontent.com ",
        GOOGLE_OAUTH_CLIENT_SECRET: "s",
      }),
    ).toEqual({ clientId: "cid.apps.googleusercontent.com", clientSecret: "s" });
    expect(() => googleOAuthConfigFromEnv({ GOOGLE_OAUTH_CLIENT_ID: "nope", GOOGLE_OAUTH_CLIENT_SECRET: "s" })).toThrow(
      "GOOGLE_OAUTH_CLIENT_ID missing or not an OAuth client ID",
    );
    expect(() => googleOAuthConfigFromEnv({ GOOGLE_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com" })).toThrow(
      "GOOGLE_OAUTH_CLIENT_SECRET missing",
    );
  });
});
