// Claude API adapter for the DraftModel boundary: the paid fallback when the free tier is not enough (SPEC:
// Integrations, AI model). Default model Claude Haiku 5.5, the small, low-cost Claude model; replies are 2 to 4
// sentences. Two short calls per review: one writes the reply, one classifies risk flags with structured output.
// Errors carry the SDK's class and status only. Nothing here logs prompts, review text or the API key.
import Anthropic from "@anthropic-ai/sdk";
import {
  DraftModelError,
  ModelRateLimitError,
  ModelRefusalError,
  flagsSchema,
  parseFlags,
  type DraftModel,
  type ModelPrompt,
} from "./provider";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 16000; // adaptive thinking is on by default; the reply itself is 2 to 4 sentences
const TIMEOUT_MS = 120_000;

const textOf = (content: Anthropic.ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

export class AnthropicDraftModel implements DraftModel {
  readonly model: string;
  private readonly apiModel: string;
  private readonly client: Anthropic;

  constructor(opts: { model?: string; client?: Anthropic } = {}) {
    this.apiModel = opts.model ?? DEFAULT_CLAUDE_MODEL;
    this.model = `anthropic:${this.apiModel}`;
    // The SDK retries 408/409/429/5xx and connection errors (2 retries by default).
    this.client = opts.client ?? new Anthropic({ timeout: TIMEOUT_MS });
  }

  private async call(prompt: ModelPrompt, format?: Anthropic.JSONOutputFormat) {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.apiModel,
        max_tokens: MAX_TOKENS,
        output_config: { effort: "low", ...(format ? { format } : {}) },
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        const after = Number(e.headers?.get?.("retry-after"));
        throw new ModelRateLimitError(Number.isFinite(after) && after >= 0 ? after : null);
      }
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
    return parseFlags(await this.call(prompt, { type: "json_schema", schema: flagsSchema(allowed) }), allowed);
  }
}
