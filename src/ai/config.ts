// Picks the AI provider for reply drafts from the environment (SPEC: Integrations, AI model; decided 2026-11-23:
// Groq's free tier first, the Claude API as the paid fallback).
//   DRAFT_PROVIDER  groq (default) | anthropic
//   DRAFT_MODEL     optional model ID override for that provider
//   GROQ_API_KEY    required for groq; the Anthropic SDK reads ANTHROPIC_API_KEY itself
// Throws with the name of the missing or malformed setting, never its value.
import { AnthropicDraftModel } from "./anthropic";
import { GroqDraftModel } from "./groq";
import type { DraftModel } from "./provider";

export function draftModelFromEnv(env: Record<string, string | undefined> = process.env): DraftModel {
  const provider = (env.DRAFT_PROVIDER?.trim() || "groq").toLowerCase();
  const model = env.DRAFT_MODEL?.trim() || undefined;
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9./:_-]{2,99}$/.test(model))
    throw new Error("DRAFT_MODEL is not a model ID");
  if (provider === "groq") {
    const apiKey = env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error("GROQ_API_KEY missing");
    return new GroqDraftModel({ apiKey, model });
  }
  if (provider === "anthropic") return new AnthropicDraftModel({ model });
  throw new Error("DRAFT_PROVIDER must be groq or anthropic");
}
