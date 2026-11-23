// Claude API adapter for the DraftModel boundary (SPEC: AI reply generation). Two short calls per review: one writes
// the reply, one classifies risk flags with structured output. A refusal is re-run on a fallback model chosen by the
// API (server-side fallbacks, "default"); a refusal after that throws ModelRefusalError. Errors carry the SDK's class
// and status only. Nothing here logs prompts, review text or the API key.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ModelRefusalError, type DraftModel, type ModelPrompt } from "./provider";

export const DEFAULT_DRAFT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 16000; // thinking is always on for this model; the reply itself is 2 to 4 sentences
const TIMEOUT_MS = 120_000;

// Raised when the Claude API call fails. Safe to log: status and error class name only.
export class DraftModelError extends Error {
  constructor(
    readonly status: number | null,
    readonly kind: string,
  ) {
    super(`Claude API call failed: status=${status ?? "none"} kind=${kind}`);
    this.name = "DraftModelError";
  }
}

const textOf = (content: Anthropic.Beta.BetaContentBlock[]) =>
  content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

export class AnthropicDraftModel implements DraftModel {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { model?: string; client?: Anthropic } = {}) {
    this.model = opts.model ?? DEFAULT_DRAFT_MODEL;
    // The SDK retries 408/409/429/5xx and connection errors (2 retries by default).
    this.client = opts.client ?? new Anthropic({ timeout: TIMEOUT_MS });
  }

  private async call(prompt: ModelPrompt, format?: Anthropic.Beta.BetaJSONOutputFormat) {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "medium", ...(format ? { format } : {}) },
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new DraftModelError(e.status ?? null, e.constructor.name);
      throw new DraftModelError(null, e instanceof Error ? e.name : "unknown");
    }
    if (res.stop_reason === "refusal") throw new ModelRefusalError();
    if (res.stop_reason === "max_tokens") throw new DraftModelError(null, "max_tokens");
    return textOf(res.content);
  }

  async writeReply(prompt: ModelPrompt) {
    return this.call(prompt);
  }

  async classifyReview(prompt: ModelPrompt, allowed: readonly string[]) {
    const schema = {
      type: "object",
      properties: { flags: { type: "array", items: { type: "string", enum: [...allowed] } } },
      required: ["flags"],
      additionalProperties: false,
    };
    const raw = await this.call(prompt, { type: "json_schema", schema });
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // handled below as an invalid classification
    }
    const parsed = z.object({ flags: z.array(z.enum(allowed as [string, ...string[]])) }).safeParse(json);
    if (!parsed.success) throw new DraftModelError(null, "invalid_classification");
    return parsed.data.flags;
  }
}

// Reads ANTHROPIC_DRAFT_MODEL (optional). The API key is read by the SDK (ANTHROPIC_API_KEY or another credential
// source it supports), never by this code.
export function draftModelFromEnv(env: Record<string, string | undefined> = process.env) {
  const model = env.ANTHROPIC_DRAFT_MODEL?.trim() || DEFAULT_DRAFT_MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(model)) throw new Error("ANTHROPIC_DRAFT_MODEL is not a model ID");
  return new AnthropicDraftModel({ model });
}
