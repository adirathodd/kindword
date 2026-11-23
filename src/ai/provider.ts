// AI provider boundary for reply drafts (SPEC: AI reply generation; Integrations: AI model). Tests use a fake; no
// live model calls. Implementations must not log prompts or outputs: they hold review text and reviewer names.

export type ModelPrompt = {
  system: string; // trusted instructions only
  user: string; // carries the untrusted review inside <review> tags
};

export interface DraftModel {
  // Saved on every draft (reply_drafts.model), e.g. "groq:openai/gpt-oss-20b".
  readonly model: string;
  // The reply text only. Throws ModelRefusalError when the model declines, ModelRateLimitError when the provider's
  // quota is used up, and DraftModelError for any other failure.
  writeReply(prompt: ModelPrompt): Promise<string>;
  // Risk flags for the review, each one of the values in `allowed`. Throws like writeReply.
  classifyReview(prompt: ModelPrompt, allowed: readonly string[]): Promise<string[]>;
}

// The model declined to answer. Carries no content.
export class ModelRefusalError extends Error {
  constructor() {
    super("The model declined the request");
    this.name = "ModelRefusalError";
  }
}

// The provider's rate limit or free-tier quota is used up. Not a fault of the review: the caller stops and tries
// again on a later run. Carries the provider's suggested wait when it gave one.
export class ModelRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super(`AI provider rate limit reached (retry after ${retryAfterSeconds ?? "unknown"} s)`);
    this.name = "ModelRateLimitError";
  }
}

// Any other failed call. Safe to log: HTTP status and a short kind only, never prompt or response text.
export class DraftModelError extends Error {
  constructor(
    readonly status: number | null,
    readonly kind: string,
  ) {
    super(`AI call failed: status=${status ?? "none"} kind=${kind}`);
    this.name = "DraftModelError";
  }
}

// Parses the {"flags": [...]} classification shared by every provider. Unknown or malformed output is an error, so
// the caller holds the draft (fail safe) instead of trusting it.
export function parseFlags(raw: string, allowed: readonly string[]): string[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DraftModelError(null, "invalid_classification");
  }
  const flags = (json as { flags?: unknown } | null)?.flags;
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === "string" && allowed.includes(f)))
    throw new DraftModelError(null, "invalid_classification");
  return flags as string[];
}

export const flagsSchema = (allowed: readonly string[]) => ({
  type: "object",
  properties: { flags: { type: "array", items: { type: "string", enum: [...allowed] } } },
  required: ["flags"],
  additionalProperties: false,
});
