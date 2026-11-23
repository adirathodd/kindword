// Unit tests for the Claude API adapter. No network: the SDK's fetch is faked, so the real request shape is checked.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ModelRefusalError } from "./provider";
import { AnthropicDraftModel, DEFAULT_DRAFT_MODEL, DraftModelError, draftModelFromEnv } from "./anthropic";

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

function client(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, client: new Anthropic({ apiKey: "sk-ant-test", fetch: fetchImpl, maxRetries: 0 }) };
}

const message = (content: unknown[], stop_reason = "end_turn") => ({
  status: 200,
  body: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: DEFAULT_DRAFT_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  },
});
const prompt = { system: "SYSTEM", user: "Review (5 stars) from Pat.\n<review>Great.</review>" };

describe("AnthropicDraftModel", () => {
  it("writes a reply: model, effort, server-side fallbacks, system and user prompt", async () => {
    const c = client([
      message([
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: " Thanks, Pat! " },
        { type: "text", text: "See you soon." },
      ]),
    ]);
    const m = new AnthropicDraftModel({ client: c.client });
    expect(m.model).toBe("claude-opus-5-5");
    expect(await m.writeReply(prompt)).toBe("Thanks, Pat! See you soon.");
    const [call] = c.calls;
    expect(call.url).toContain("/v1/messages");
    expect(call.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call.body).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: "SYSTEM",
      messages: [{ role: "user", content: prompt.user }],
    });
    expect(call.body).not.toHaveProperty("thinking");
    expect(call.body).not.toHaveProperty("temperature");
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

  it("wraps API errors with status and class only", async () => {
    const c = client([
      { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } },
    ]);
    const err = await new AnthropicDraftModel({ client: c.client }).writeReply(prompt).catch((e) => e);
    expect(err).toBeInstanceOf(DraftModelError);
    expect(err).toMatchObject({ status: 429, kind: "RateLimitError" });
    expect(err.message).not.toContain("slow down");
  });

  it("classifies with a JSON schema limited to the allowed flags", async () => {
    const c = client([message([{ type: "text", text: '{"flags":["legal","injury"]}' }])]);
    const m = new AnthropicDraftModel({ client: c.client });
    expect(await m.classifyReview(prompt, ["legal", "injury", "spam"])).toEqual(["legal", "injury"]);
    expect(c.calls[0].body.output_config).toEqual({
      effort: "medium",
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

describe("draftModelFromEnv", () => {
  it("defaults to claude-opus-5-5 and accepts an override", () => {
    expect(draftModelFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" }).model).toBe("claude-opus-5-5");
    expect(
      draftModelFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_DRAFT_MODEL: " claude-haiku-5-5 " }).model,
    ).toBe("claude-haiku-5-5");
  });

  it("rejects a malformed model ID", () => {
    expect(() => draftModelFromEnv({ ANTHROPIC_DRAFT_MODEL: "x; rm -rf" })).toThrow(/ANTHROPIC_DRAFT_MODEL/);
  });
});
