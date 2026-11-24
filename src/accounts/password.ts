// Owner passwords (SPEC FR-24): Argon2id through node:crypto (Node 24.7+), stored as a PHC string, plus a check
// against breached passwords. A password is never logged or stored in any other form.
import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

// OWASP's Argon2id baseline: 19 MiB, 2 passes, 1 lane.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

const run = (message: string, nonce: Buffer, p: typeof PARAMS) =>
  new Promise<Buffer>((resolve, reject) =>
    argon2("argon2id", { message, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await run(password, salt, PARAMS);
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5], "base64url");
  const key = await run(password, Buffer.from(m[4], "base64url"), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(key, expected);
}

// A real hash of a random password, so a sign-in for an unknown email costs the same time as a wrong password.
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}

export interface BreachChecker {
  // True when the password appears in known breaches. Must never send or log the password.
  isBreached(password: string): Promise<boolean>;
}

// Have I Been Pwned's range API (k-anonymity): only the first 5 hex characters of the SHA-1 leave this server, with
// padding so the response size reveals nothing. No account or key needed.
export class PwnedPasswords implements BreachChecker {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async isBreached(password: string) {
    const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    try {
      const res = await this.fetchImpl(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const suffix = sha1.slice(5);
      return (await res.text()).split("\n").some((line) => {
        const [s, count] = line.trim().split(":");
        return s === suffix && Number(count) > 0; // count 0 = padding
      });
    } catch {
      // shortcut: fails open (sign-up still works) when the service is down; upgrade to a local list if that matters.
      console.warn("breached-password check unavailable");
      return false;
    }
  }
}
