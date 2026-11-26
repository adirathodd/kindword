// Makes the operator's sign-in settings (SPEC Security: password plus two-factor; src/operator/auth.ts):
// OPERATOR_PASSWORD_HASH (Argon2id, the same format as owner passwords in src/accounts/password.ts) and
// OPERATOR_TOTP_SECRET (base32, for an authenticator app). Run it on your own computer, paste the two values into the
// host's secret store, and add the secret to an authenticator app. Nothing is written to disk or sent anywhere, and
// the password is never printed. Usage: npm run operator:setup -- ops@example.com
import { argon2, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npm run operator:setup -- <operator email>");
  process.exit(1);
}

// One reader for both questions; typed characters are not echoed.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let prompt = "";
rl._writeToOutput = (s) => {
  if (s.includes(prompt)) process.stdout.write(prompt);
};
const lines = rl[Symbol.asyncIterator]();
async function ask(question) {
  prompt = question;
  process.stdout.write(question);
  const { value } = await lines.next();
  process.stdout.write("\n");
  return value ?? "";
}

const password = await ask("Operator password (at least 16 characters, not shown): ");
if (password.length < 16 || password.length > 256) {
  console.error("Use a password of 16 to 256 characters.");
  process.exit(1);
}
const again = await ask("Type it again: ");
rl.close();
if (again !== password) {
  console.error("The passwords do not match.");
  process.exit(1);
}

// OWASP's Argon2id baseline, as in src/accounts/password.ts.
const params = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
const salt = randomBytes(16);
const key = await new Promise((resolve, reject) =>
  argon2("argon2id", { message: password, nonce: salt, ...params }, (err, k) => (err ? reject(err) : resolve(k))),
);
const hash = `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${salt.toString("base64url")}$${key.toString("base64url")}`;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = 0;
let value = 0;
let secret = "";
for (const byte of randomBytes(20)) {
  value = (value << 8) | byte;
  bits += 8;
  while (bits >= 5) {
    secret += ALPHABET[(value >>> (bits - 5)) & 31];
    bits -= 5;
  }
}
const uri = `otpauth://totp/Kindword:${encodeURIComponent(email)}?secret=${secret}&issuer=Kindword&algorithm=SHA1&digits=6&period=30`;

console.log(`
Add these to the host's secret store (production only), then clear this output:

OPERATOR_EMAIL=${email}
OPERATOR_PASSWORD_HASH=${hash}
OPERATOR_TOTP_SECRET=${secret}

Authenticator app: add an account with this setup key, or turn this link into a QR code on your own computer:
${uri}
`);
