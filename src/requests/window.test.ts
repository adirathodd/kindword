import { describe, expect, it } from "vitest";
import { inSendWindow, nextSendTime } from "./window";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);

describe("send window (9 a.m. to 8 p.m. local)", () => {
  it("keeps a time already inside the window", () => {
    const t = at("2026-11-23T14:30:00Z"); // 9:30 a.m. EST
    expect(nextSendTime(t, NY)).toEqual(t);
    expect(inSendWindow(t, NY)).toBe(true);
  });

  it("moves an early-morning time to 9 a.m. the same local day", () => {
    expect(nextSendTime(at("2026-11-23T12:00:00Z"), NY)).toEqual(at("2026-11-23T14:00:00Z")); // 7 a.m. EST
  });

  it("treats 8:00 p.m. as outside and moves it to 9 a.m. the next day", () => {
    const eight = at("2026-11-24T01:00:00Z"); // 8:00 p.m. EST on Nov 23
    expect(inSendWindow(eight, NY)).toBe(false);
    expect(nextSendTime(eight, NY)).toEqual(at("2026-11-24T14:00:00Z"));
    expect(inSendWindow(at("2026-11-24T00:59:59Z"), NY)).toBe(true); // 7:59:59 p.m.
  });

  it("uses the location's zone, not UTC: 11 p.m. UTC is 6 p.m. in New York", () => {
    expect(inSendWindow(at("2026-11-23T23:00:00Z"), NY)).toBe(true);
    expect(inSendWindow(at("2026-11-23T23:00:00Z"), "UTC")).toBe(false);
  });

  it("rolls over month and year ends", () => {
    expect(nextSendTime(at("2027-01-01T02:00:00Z"), NY)).toEqual(at("2027-01-01T14:00:00Z")); // 9 p.m. Dec 31
  });

  it("handles daylight saving: 9 a.m. is 13:00 UTC in summer and 14:00 UTC in winter", () => {
    // 2026-03-08 is the spring-forward day; 10 p.m. Mar 7 EST -> 9 a.m. Mar 8 EDT.
    expect(nextSendTime(at("2026-03-08T03:00:00Z"), NY)).toEqual(at("2026-03-08T13:00:00Z"));
    // 2026-11-01 is the fall-back day; 10 p.m. Oct 31 EDT -> 9 a.m. Nov 1 EST.
    expect(nextSendTime(at("2026-11-01T02:00:00Z"), NY)).toEqual(at("2026-11-01T14:00:00Z"));
  });
});
