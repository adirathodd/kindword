import { describe, expect, it } from "vitest";
import { draftModelFromEnv } from "./config";

describe("draftModelFromEnv", () => {
  it("defaults to Groq's free tier with gpt-oss-20b", () => {
    expect(draftModelFromEnv({ GROQ_API_KEY: "gsk_x" }).model).toBe("groq:openai/gpt-oss-20b");
  });

  it("accepts a model override", () => {
    expect(draftModelFromEnv({ GROQ_API_KEY: "gsk_x", DRAFT_MODEL: " openai/gpt-oss-120b " }).model).toBe(
      "groq:openai/gpt-oss-120b",
    );
  });

  it("switches to the Claude API fallback (Claude Haiku 5.5 by default)", () => {
    expect(draftModelFromEnv({ DRAFT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x" }).model).toBe(
      "anthropic:claude-haiku-5-5",
    );
  });

  it("names the missing or malformed setting, never its value", () => {
    expect(() => draftModelFromEnv({})).toThrow(/^GROQ_API_KEY missing$/);
    expect(() => draftModelFromEnv({ DRAFT_PROVIDER: "gemini" })).toThrow(/DRAFT_PROVIDER/);
    // The SDK would only fail on the first request, after each review had been tried.
    expect(() => draftModelFromEnv({ DRAFT_PROVIDER: "anthropic" })).toThrow(/^ANTHROPIC_API_KEY missing$/);
    expect(() => draftModelFromEnv({ DRAFT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: " " })).toThrow(
      /^ANTHROPIC_API_KEY missing$/,
    );
    expect(() => draftModelFromEnv({ GROQ_API_KEY: "gsk_x", DRAFT_MODEL: "x; rm -rf /" })).toThrow(
      /^DRAFT_MODEL is not a model ID$/,
    );
  });
});
