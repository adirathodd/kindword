// AI provider boundary for reply drafts (SPEC: AI reply generation; Integrations: Claude API). Tests use a fake; no
// live model calls. Implementations must not log prompts or outputs: they hold review text and reviewer names.

export type ModelPrompt = {
  system: string; // trusted instructions only
  user: string; // carries the untrusted review inside <review> tags
};

export interface DraftModel {
  // Saved on every draft (reply_drafts.model).
  readonly model: string;
  // The reply text only. Throws ModelRefusalError when the model declines, any other error when the call fails.
  writeReply(prompt: ModelPrompt): Promise<string>;
  // Risk flags for the review, each one of the values in `allowed`. Throws when the call fails.
  classifyReview(prompt: ModelPrompt, allowed: readonly string[]): Promise<string[]>;
}

// The model declined to answer (stop_reason "refusal" after any fallback). Carries no content.
export class ModelRefusalError extends Error {
  constructor() {
    super("The model declined the request");
    this.name = "ModelRefusalError";
  }
}
