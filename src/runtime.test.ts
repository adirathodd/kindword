// The Node version the app needs (FR-24): owner passwords are hashed with node:crypto's argon2, added in Node 24.7.
// package.json engines (which also picks the Node version on Vercel), .nvmrc and both CI workflows name the same
// major, and the Node running the tests meets it, so an older Node fails here with one clear message instead of
// failing every account test with "argon2 is not a function".
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MAJOR = 24;
const MIN_MINOR = 7;

describe("Node version", () => {
  it("is pinned to Node 24 in package.json, .nvmrc and CI", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.engines).toEqual({ node: `${MAJOR}.x` });
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    expect(lock.packages[""].engines).toEqual(pkg.engines);
    expect((await readFile(".nvmrc", "utf8")).trim()).toBe(String(MAJOR));
    for (const wf of [".github/workflows/ci.yml", ".github/workflows/migrate.yml"])
      expect(await readFile(wf, "utf8")).toMatch(new RegExp(`node-version: ${MAJOR}\\s`));
  });

  it(`runs on Node ${MAJOR}.${MIN_MINOR} or later with crypto.argon2`, () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(
      major > MAJOR || (major === MAJOR && minor >= MIN_MINOR),
      `Node ${MAJOR}.${MIN_MINOR}+ is required, this is ${process.versions.node}`,
    ).toBe(true);
    expect(typeof (crypto as { argon2?: unknown }).argon2).toBe("function");
  });
});
