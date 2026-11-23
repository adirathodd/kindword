// Groq adapter for the DraftModel boundary: the v0.1 default, on Groq's free tier (SPEC: Integrations, AI model).
// One OpenAI-compatible REST call per step, no SDK. Default model openai/gpt-oss-20b: small, not a preview model,
// and it supports strict structured output for the risk check.
// Groq's terms bar training on our inputs; turn on Zero Data Retention in the Groq console. Free-tier limits (requests
// and tokens per minute and per day) surface as ModelRateLimitError so the caller stops and retries on a later run.
// Errors carry the HTTP status and Groq's error code only. Nothing here logs prompts, review text or the API key.
import {
  DraftModelError,
  ModelRateLimitError,
  ModelRefusalError,
  flagsSchema,
  parseFlags,
  type DraftModel,
  type ModelPrompt,
} from "./provider";

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3; // network errors and 5xx only; a 429 is never retried here
const BASE_DELAY_MS = 1000;
const MAX_COMPLETION_TOKENS = 2000; // reasoning plus a 2 to 4 sentence reply

export type GroqConfig = { apiKey: string; model?: string };
export type GroqOptions = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

type ChatResponse = {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  error?: { code?: unknown; type?: unknown };
};

const safeCode = (v: unknown) => (typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v) ? v : "error");

export class GroqDraftModel implements DraftModel {
  readonly model: string;
  private readonly apiModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: GroqConfig,
    opts: GroqOptions = {},
  ) {
    this.apiModel = config.model ?? DEFAULT_GROQ_MODEL;
    this.model = `groq:${this.apiModel}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call(prompt: ModelPrompt, responseFormat?: Record<string, unknown>): Promise<string> {
    const body = JSON.stringify({
      model: this.apiModel,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      reasoning_effort: "low",
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });

    let last = new DraftModelError(null, "not_sent");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        last = new DraftModelError(null, e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network");
        if (attempt < MAX_ATTEMPTS) await this.sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      const json = (await res.json().catch(() => null)) as ChatResponse | null;
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after"));
        throw new ModelRateLimitError(Number.isFinite(after) && after >= 0 ? after : null);
      }
      if (res.status >= 500) {
        last = new DraftModelError(res.status, safeCode(json?.error?.code ?? json?.error?.type));
        if (attempt < MAX_ATTEMPTS) await this.sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) throw new DraftModelError(res.status, safeCode(json?.error?.code ?? json?.error?.type));

      const choice = json?.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason === "content_filter") throw new ModelRefusalError();
      if (choice?.finish_reason === "length") throw new DraftModelError(null, "max_tokens");
      const text = choice?.message?.content?.trim();
      if (!text) throw new DraftModelError(null, "empty_response");
      return text;
    }
    throw last;
  }

  writeReply(prompt: ModelPrompt) {
    return this.call(prompt);
  }

  async classifyReview(prompt: ModelPrompt, allowed: readonly string[]) {
    const raw = await this.call(prompt, {
      type: "json_schema",
      json_schema: { name: "review_flags", strict: true, schema: flagsSchema(allowed) },
    });
    return parseFlags(raw, allowed);
  }
}
