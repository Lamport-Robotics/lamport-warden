/**
 * The check that is run from outside the server (scripts/check-live.mjs): what counts as "watching", and
 * that one dropped connection is not called an outage.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error a plain script, shared with the command line
import { STALE_AFTER_SECONDS, ask, wrongWith } from "../../../scripts/check-live.mjs";

const NOW = 1_794_570_000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("the check from outside", () => {
  it("is satisfied by a service that finished a round lately and can read at least one wallet", () => {
    expect(wrongWith({ ok: true, watching: 0, lastPassAt: NOW - 30, blind: 0 }, NOW)).toBeNull(); // nobody signed up yet: still watching
    expect(wrongWith({ ok: true, watching: 12, lastPassAt: NOW - 59, blind: 0 }, NOW)).toBeNull();
    expect(wrongWith({ ok: true, watching: 12, lastPassAt: NOW - STALE_AFTER_SECONDS, blind: 11 }, NOW)).toBeNull(); // one wallet unread is its owner's news
  });

  it("says why when it is not: no round yet, a round long ago, every wallet unread, or not all right", () => {
    expect(wrongWith({ ok: true, watching: 3, lastPassAt: null, blind: 0 }, NOW)).toBe("the service is up and has not finished a single round of reading wallets.");
    expect(wrongWith({ ok: true, watching: 3, lastPassAt: NOW - 3600, blind: 0 }, NOW)).toBe("the last round of reading wallets ended 60 minutes ago: the watcher has stopped while the service still answers.");
    expect(wrongWith({ ok: true, watching: 3, lastPassAt: NOW - 30, blind: 3 }, NOW)).toBe("none of the 3 watched wallets can be read: the RPC is refusing or down.");
    for (const bad of [null, "ok", {}, { ok: false }, { error: "something went wrong here." }]) expect(wrongWith(bad, NOW)).toBe("the service answered, and did not say it was all right.");
  });

  it("asks again before calling it down, and gives up after a few tries", async () => {
    const health = { ok: true, watching: 1, lastPassAt: NOW, blind: 0 };
    let calls = 0;
    const flaky = async () => { calls += 1; if (calls < 3) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }); return { ok: true, status: 200, json: async () => health }; };
    const waits: number[] = [];
    expect(await ask("https://x", { fetchImpl: flaky, sleep: async (ms: number) => { waits.push(ms); } })).toEqual({ ok: true, health });
    expect(waits).toEqual([20_000, 20_000]);

    const down = async () => ({ ok: false, status: 502, json: async () => ({}) });
    expect(await ask("https://x", { fetchImpl: down, sleep: async () => undefined })).toEqual({ ok: false, why: "the service did not answer in 3 tries (it answered 502)." });
    const dead = async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
    expect(await ask("https://x", { fetchImpl: dead, sleep: async () => undefined, tries: 2 })).toEqual({ ok: false, why: "the service did not answer in 2 tries (ENOTFOUND)." });
  });

  it("is what the scheduled workflow runs, with no secret and no permission", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "sentinel-watch.yml"), "utf8");
    expect(workflow).toContain("run: node scripts/check-live.mjs");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toMatch(/cron: "[\d,]+ \* \* \* \*"/);
    expect(workflow).not.toMatch(/secrets\./);
    // the address it asks is the one the page and the extension use
    expect(readFileSync(join(root, "scripts", "check-live.mjs"), "utf8")).toContain("https://warden.lamportrobotics.com/sentinel/api/v1/health");
    expect(readFileSync(join(root, "src", "defaults.ts"), "utf8")).toContain("/sentinel/api");
  });
});
