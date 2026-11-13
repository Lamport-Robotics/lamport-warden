/**
 * The "Try Warden" page promises, beside each button, what Warden will do with the request. This hands every
 * one of those requests to the same engine the extension runs and checks the promise: quiet, asks, or stops.
 */
import "../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { judge, recordSigned, type Store } from "../src/judge.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";
import { SCENARIOS, WILL, lookalike, resultText, type Ask } from "../site/try/src/scenarios.js";

const ORIGIN = "https://warden.lamportrobotics.com";
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(41)).publicKey;
const friend = Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey;

function memoryStore(): Store {
  const kept = new Map<string, MemoryState>();
  return { load: async (o) => kept.get(o), save: async (o, s) => { kept.set(o, s); }, ringSites: async () => [] };
}

/** What the wallet hook hands the judge for one ask (intercept.ts does this in the page). */
const requestOf = (ask: Ask) =>
  ask.kind === "tx" ? { kind: "tx" as const, bytes: ask.transaction, owner: wallet.toBase58() }
  : ask.kind === "msg" ? { kind: "msg" as const, bytes: ask.message, owner: wallet.toBase58() }
  : { kind: "signin" as const, bytes: new TextEncoder().encode(JSON.stringify(ask.input)), owner: wallet.toBase58() };

const LEVELS = { quiet: ["allow"], asks: ["explain", "confirm"], stops: ["block"] } as const;

describe("the practice page's requests", () => {
  it("each gets from the engine what the page says it will", async () => {
    const store = memoryStore();
    const seen: Record<string, { level: string; sentence: string }> = {};
    // in the order a visitor meets them: the ones that need a first payment come after it was let through
    for (const s of [...SCENARIOS].sort((a, b) => Number(!!a.after) - Number(!!b.after))) {
      const judged = await judge(requestOf(s.build(wallet, friend)), ORIGIN, store);
      seen[s.id] = { level: judged.verdict.level, sentence: judged.verdict.sentence };
      expect(LEVELS[s.outcome] as readonly string[], `${s.id}: ${judged.verdict.level}: ${judged.verdict.sentence}`).toContain(judged.verdict.level);
      // the visitor continues the first payment, and the wallet signs it
      if (s.id === "pay-new") await recordSigned(judged, store, 1_794_312_000);
    }
    // SHOW_VERDICTS=/some/file.json keeps what the engine said about each, to read
    if (process.env.SHOW_VERDICTS) writeFileSync(process.env.SHOW_VERDICTS, JSON.stringify(seen, null, 1));
    expect(seen["pay-new"]!.sentence).toMatch(/Sends 0\.5 SOL to .*never paid/);
    expect(seen["signin-relay"]!.sentence).toContain("app.example-exchange.com, a different site");
  });

  it("before the first payment is let through, the same address is still someone new", async () => {
    const again = SCENARIOS.find((s) => s.id === "pay-again")!;
    expect((await judge(requestOf(again.build(wallet, friend)), ORIGIN, memoryStore())).verdict.level).not.toBe("allow");
  });

  it("the look-alike starts and ends like the address it copies, and is another address", () => {
    const fake = lookalike(friend).toBase58(), real = friend.toBase58();
    expect(fake).not.toBe(real);
    expect(fake.slice(0, 4)).toBe(real.slice(0, 4));
    expect(fake.slice(-4)).toBe(real.slice(-4));
    // for any address a visitor's page could make up, not just this one
    for (let i = 0; i < 200; i++) {
      const k = Keypair.generate().publicKey, f = lookalike(k).toBase58();
      expect(f.slice(0, 3), k.toBase58()).toBe(k.toBase58().slice(0, 3));
      expect(f.slice(-4), k.toBase58()).toBe(k.toBase58().slice(-4));
      expect(() => new PublicKey(f)).not.toThrow();
    }
  });

  it("says what happened as it happened: with Warden, without it, and when Warden failed", () => {
    // with Warden: stopped is good, and a stop that reached the wallet is said to be Warden's failure
    expect(resultText("stops", false, "refused", true)).toEqual({ text: "Stopped. The practice wallet was never asked.", kind: "good" });
    expect(resultText("stops", true, "signed", true)).toMatchObject({ kind: "bad", text: expect.stringContaining("Warden should have stopped it") });
    expect(resultText("asks", false, "refused", true).text).toBe("You cancelled, so the practice wallet was never asked.");
    expect(resultText("asks", true, "signed", true).kind).toBe("good");
    expect(resultText("quiet", true, "signed", true).text).toContain("had nothing to say");
    expect(resultText("quiet", false, "refused", true).kind).toBe("plain");
    // without Warden: the wallet signing a theft is never called good, and Warden is never credited
    for (const outcome of ["quiet", "asks", "stops"] as const) {
      const said = resultText(outcome, true, "signed", false);
      expect(said.text, outcome).toContain("Nothing stood in between: Warden is not in this browser.");
      expect(said.kind, outcome).toBe(outcome === "stops" ? "bad" : "plain");
      expect(resultText(outcome, false, "refused", false)).toEqual({ text: "The request did not reach the practice wallet.", kind: "plain" });
    }
    // nothing the page says claims a real payment, and each kind of outcome has its words
    for (const outcome of ["quiet", "asks", "stops"] as const) for (const reached of [true, false]) for (const w of [true, false]) expect(resultText(outcome, reached, reached ? "signed" : "refused", w).text).not.toMatch(/was sent to|was paid|you paid/i);
    expect(Object.keys(WILL).sort()).toEqual(["asks", "quiet", "stops"]);
  });

  it("every request names the practice wallet as its signer and nobody else", () => {
    for (const s of SCENARIOS) {
      const ask = s.build(wallet, friend);
      if (ask.kind !== "tx") continue;
      expect(ask.transaction.length, s.id).toBeGreaterThan(64);
      expect(ask.transaction[0], s.id).toBe(1); // one signature slot: the wallet's
    }
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS.filter((x) => x.after)) expect(SCENARIOS.some((x) => x.id === s.after)).toBe(true);
  });
});
