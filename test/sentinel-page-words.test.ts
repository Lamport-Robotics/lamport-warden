/**
 * The Sentinel page's standing advice for the moment an alert turns out to be real. It has to be there for
 * someone who is not signed in (they may be reading it on another device, in a hurry), and it must never
 * send them anywhere or ask them to sign.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "sentinel", "web", "index.html"), "utf8");
const real = page.slice(page.indexOf('<section id="real">'), page.indexOf("</main>"));

describe("when an alert is real", () => {
  it("is on the page for anyone, signed in or not", () => {
    const signedIn = page.slice(page.indexOf('<div id="signedIn" hidden>'));
    const closes = signedIn.indexOf("\n  </div>");
    expect(closes).toBeGreaterThan(0);
    expect(signedIn.indexOf('<section id="real">')).toBeGreaterThan(closes); // after the part only an owner sees
    expect(real).toContain("<h2>When an alert is real</h2>");
  });

  it("puts not signing first, a new phrase before moving anything, and tells the two cases apart", () => {
    const steps = [...real.matchAll(/<li><b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(steps).toEqual(["Sign nothing you are sent.", "Make a new wallet with a new recovery phrase,", "Move what is left to it,", "Then what is locked:", "Tell Sentinel."]);
    expect(real).toContain("Not another account under the old phrase: the phrase is what leaked.");
    expect(real).toContain("A transaction you never signed");
    expect(real).toContain("A permission you gave without meaning to");
    expect(real).toContain("If you are not sure, treat it as the first.");
  });

  it("links nowhere and names no product to install", () => {
    expect(real).not.toMatch(/<a\b|https?:\/\//);
    expect(real).toContain("Sentinel never sends a link and never asks you to sign.");
  });
});
