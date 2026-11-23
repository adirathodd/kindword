// Unit tests for the Claude API adapter (paid fallback). No network: the SDK's fetch is faked, so the real request
// shape is checked.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DraftModelError, ModelRateLimitError, ModelRefusalError } from "./provider";
import { AnthropicDraftModel } from "./anthropic";

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

function client(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof fetch;
  return { calls, client: new Anthropic({ apiKey: "sk-ant-test", fetch: fetchImpl, maxRetries: 0 }) };
}

const message = (content: unknown[], stop_reason = "end_turn") => ({
  status: 200,
  body: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  },
});
const prompt = { system: "SYSTEM", user: "Review (5 stars) from Pat.\n<review>Great.</review>" };

describe("AnthropicDraftModel", () => {
  it("writes a reply with Claude Haiku 5.5 at low effort", async () => {
    const c = client([
      message([
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: " Thanks, Pat! " },
        { type: "text", text: "See you soon." },
      ]),
    ]);
    const m = new AnthropicDraftModel({ client: c.client });
    expect(m.model).toBe("anthropic:claude-haiku-5-5");
    expect(await m.writeReply(prompt)).toBe("Thanks, Pat! See you soon.");
    const [call] = c.calls;
    expect(call.url).toContain("/v1/messages");
    expect(call.body).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low" },
      system: "SYSTEM",
      messages: [{ role: "user", content: prompt.user }],
    });
    expect(call.body).not.toHaveProperty("thinking");
    expect(call.body).not.toHaveProperty("temperature");
  });

  it("uses a model override", async () => {
    const c = client([message([{ type: "text", text: "Hi. Bye." }])]);
    const m = new AnthropicDraftModel({ client: c.client, model: "claude-sonnet-5-5" });
    await m.writeReply(prompt);
    expect(m.model).toBe("anthropic:claude-sonnet-5-5");
    expect(c.calls[0].body.model).toBe("claude-sonnet-5-5");
  });

  it("throws ModelRefusalError on a refusal", async () => {
    const c = client([message([], "refusal")]);
    await expect(new AnthropicDraftModel({ client: c.client }).writeReply(prompt)).rejects.toBeInstanceOf(
      ModelRefusalError,
    );
  });

  it("throws on a reply cut off by max_tokens", async () => {
    const c = client([message([{ type: "text", text: "Thanks" }], "max_tokens")]);
    await expect(new AnthropicDraftModel({ client: c.client }).writeReply(prompt)).rejects.toMatchObject({
      kind: "max_tokens",
    });
  });

  it("turns a 429 into ModelRateLimitError", async () => {
    const c = client([
      {
        status: 429,
        body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        headers: { "retry-after": "30" },
      },
    ]);
    const err = await new AnthropicDraftModel({ client: c.client }).writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("reports an unknown wait (not 0 s) for a 429 without retry-after", async () => {
    const c = client([{ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "x" } } }]);
    const err = await new AnthropicDraftModel({ client: c.client }).writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRateLimitError);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it("wraps other API errors with status and class only", async () => {
    const c = client([
      { status: 500, body: { type: "error", error: { type: "api_error", message: "secret detail" } } },
    ]);
    const err = await new AnthropicDraftModel({ client: c.client }).writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(DraftModelError);
    expect(err).toMatchObject({ status: 500, kind: "InternalServerError" });
    expect(err.message).not.toContain("secret detail");
  });

  it("classifies with a JSON schema limited to the allowed flags", async () => {
    const c = client([message([{ type: "text", text: '{"flags":["legal","injury"]}' }])]);
    const m = new AnthropicDraftModel({ client: c.client });
    expect(await m.classifyReview(prompt, ["legal", "injury", "spam"])).toEqual(["legal", "injury"]);
    expect(c.calls[0].body.output_config).toEqual({
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { flags: { type: "array", items: { type: "string", enum: ["legal", "injury", "spam"] } } },
          required: ["flags"],
          additionalProperties: false,
        },
      },
    });
  });

  it.each([["not json"], ['{"flags":["made_up"]}'], ['{"other":1}']])("rejects a bad classification: %s", async (t) => {
    const c = client([message([{ type: "text", text: t }])]);
    await expect(new AnthropicDraftModel({ client: c.client }).classifyReview(prompt, ["legal"])).rejects.toMatchObject(
      { kind: "invalid_classification" },
    );
  });
});
