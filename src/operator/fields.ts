// Small form helpers for the operator pages.
import type { Fields } from "./businesses";

// The same form, reading only fields named "<prefix><name>" (the new-business form holds the first location too).
export const prefixed = (f: Fields, prefix: string): Fields => ({
  get: (k) => f.get(prefix + k),
  all: (k) => f.all(prefix + k),
});

// The confirmation after a redirect; only fixed messages, never echoed input.
const SAVED: Record<string, string> = {
  created: "Business added. It is in onboarding; nothing is sent until it is switched to live.",
  business: "Business saved.",
  location: "Location saved.",
};
export const savedNotice = (key: string | null) => (key && Object.hasOwn(SAVED, key) ? SAVED[key] : null);
