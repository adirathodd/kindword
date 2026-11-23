// Unit tests for the Groq adapter (v0.1 default, free tier). No network: fetch is faked and sleep is instant.
import { describe, expect, it } from "vitest";
import { DraftModelError, ModelRateLimitError, ModelRefusalError } from "./provider";
import { DEFAULT_GROQ_MODEL, GroqDraftModel } from "./groq";

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (content: string | null, finish_reason = "stop", extra: Record<string, unknown> = {}) =>
  json(200, { choices: [{ index: 0, finish_reason, message: { role: "assistant", content, ...extra } }] });

function adapter(responses: Array<Response | Error>, model?: string) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const m = new GroqDraftModel({ apiKey: "gsk_test", model }, { fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  return { m, calls, sleeps };
}
const body = (c: Call) => JSON.parse(String(c.init.body));
const prompt = { system: "SYSTEM", user: "Review (5 stars) from Pat.\n<review>Great.</review>" };

describe("GroqDraftModel", () => {
  it("defaults to openai/gpt-oss-20b and sends an OpenAI-style chat request", async () => {
    const { m, calls } = adapter([ok("  Thanks, Pat! See you soon. ")]);
    expect(DEFAULT_GROQ_MODEL).toBe("openai/gpt-oss-20b");
    expect(m.model).toBe("groq:openai/gpt-oss-20b");
    expect(await m.writeReply(prompt)).toBe("Thanks, Pat! See you soon.");
    const [c] = calls;
    expect(c.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer gsk_test");
    expect(body(c)).toEqual({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: prompt.user },
      ],
      max_completion_tokens: 2000,
      reasoning_effort: "low",
    });
  });

  it("uses a model override", async () => {
    const { m, calls } = adapter([ok("Hi. Bye.")], "openai/gpt-oss-120b");
    await m.writeReply(prompt);
    expect(m.model).toBe("groq:openai/gpt-oss-120b");
    expect(body(calls[0]).model).toBe("openai/gpt-oss-120b");
  });

  it("classifies with a strict JSON schema limited to the allowed flags", async () => {
    const { m, calls } = adapter([ok('{"flags":["legal"]}')]);
    expect(await m.classifyReview(prompt, ["legal", "spam"])).toEqual(["legal"]);
    expect(body(calls[0]).response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "review_flags",
        strict: true,
        schema: {
          type: "object",
          properties: { flags: { type: "array", items: { type: "string", enum: ["legal", "spam"] } } },
          required: ["flags"],
          additionalProperties: false,
        },
      },
    });
  });

  it.each([["nope"], ['{"flags":["approve_me"]}'], ['{"flags":"legal"}']])(
    "rejects a bad classification: %s",
    async (t) => {
      const { m } = adapter([ok(t)]);
      await expect(m.classifyReview(prompt, ["legal"])).rejects.toMatchObject({ kind: "invalid_classification" });
    },
  );

  it("turns a 429 (free-tier limit) into ModelRateLimitError without retrying", async () => {
    const { m, calls } = adapter([
      json(
        429,
        { error: { message: "Rate limit reached for tokens per day", code: "rate_limit_exceeded" } },
        {
          "retry-after": "120",
        },
      ),
    ]);
    const err = await m.writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect(err.retryAfterSeconds).toBe(120);
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown wait (not 0 s) for a 429 without retry-after", async () => {
    const { m } = adapter([json(429, { error: { code: "rate_limit_exceeded" } })]);
    const err = await m.writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it("retries 5xx and network errors with backoff", async () => {
    const { m, calls, sleeps } = adapter([
      json(503, { error: { type: "service_unavailable" } }),
      new TypeError("fetch failed"),
      ok("Thanks. Bye."),
    ]);
    expect(await m.writeReply(prompt)).toBe("Thanks. Bye.");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after 3 attempts with a safe error", async () => {
    const { m } = adapter([json(500, {}), json(502, {}), json(500, { error: { code: "internal_error" } })]);
    await expect(m.writeReply(prompt)).rejects.toMatchObject({ status: 500, kind: "internal_error" });
  });

  it("does not retry a 4xx, and never puts Groq's message in the error", async () => {
    const { m, calls } = adapter([
      json(400, { error: { message: "bad input: Great.", type: "invalid_request_error", code: "model_not_found" } }),
    ]);
    const err = await m.writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(DraftModelError);
    expect(err).toMatchObject({ status: 400, kind: "model_not_found" });
    expect(err.message).not.toContain("Great");
    expect(calls).toHaveLength(1);
  });

  it("treats a refusal or content filter as ModelRefusalError", async () => {
    const a = adapter([ok(null, "stop", { refusal: "I can't help with that." })]);
    await expect(a.m.writeReply(prompt)).rejects.toBeInstanceOf(ModelRefusalError);
    const b = adapter([ok("", "content_filter")]);
    await expect(b.m.writeReply(prompt)).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("fails on a cut-off or empty reply", async () => {
    await expect(adapter([ok("Thanks", "length")]).m.writeReply(prompt)).rejects.toMatchObject({ kind: "max_tokens" });
    await expect(adapter([ok("   ")]).m.writeReply(prompt)).rejects.toMatchObject({ kind: "empty_response" });
    await expect(adapter([json(200, {})]).m.writeReply(prompt)).rejects.toMatchObject({ kind: "empty_response" });
  });
});
