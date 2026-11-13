/**
 * The RPC client keeping to the pace an RPC will take. Time here is a number the test moves: a wait adds to
 * it and returns at once.
 */
import { describe, it, expect } from "vitest";
import { HEAVY, HttpRpc, PUBLIC_RPC_PACE, type FetchLike } from "../src/rpc.js";

function setup(pace: { heavyPer10s?: number; lightPer10s?: number } | undefined, answers: (n: number, method: string) => { status: number; retryAfter?: string; body?: unknown } = () => ({ status: 200 })) {
  let t = 0, n = 0;
  const started: { at: number; method: string }[] = [];
  const waits: number[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const method = JSON.parse(init.body).method as string;
    started.push({ at: t, method });
    const a = answers(++n, method);
    return { ok: a.status < 300, status: a.status, json: async () => a.body ?? { result: method }, headers: { get: (name) => (name.toLowerCase() === "retry-after" ? a.retryAfter ?? null : null) } };
  };
  const rpc = new HttpRpc("https://rpc.example", fetchImpl, { pace, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  return { rpc, started, waits, at: () => t, advance: (ms: number) => { t += ms; } };
}

describe("the pace an RPC is asked at", () => {
  it("spaces the calls an RPC rations evenly, and the rest on their own, faster lane", async () => {
    const s = setup({ heavyPer10s: 10, lightPer10s: 40 });
    for (let i = 0; i < 5; i++) await s.rpc.call("getSignaturesForAddress", []);
    expect(s.started.map((x) => x.at)).toEqual([0, 1000, 2000, 3000, 4000]); // one a second: never more than ten in ten
    // the other lane has not been used: it starts at once, and at its own pace
    const from = s.at();
    for (let i = 0; i < 3; i++) await s.rpc.call("getAccountInfo", []);
    expect(s.started.slice(5).map((x) => x.at - from)).toEqual([0, 250, 500]);
    // both kinds of listing share the rationed lane
    expect([...HEAVY].sort()).toEqual(["getSignaturesForAddress", "getTokenAccountsByOwner"]);
    await s.rpc.call("getTokenAccountsByOwner", []);
    expect(s.started.at(-1)!.at).toBe(5000);
    expect(s.rpc.heavyPerMinute).toBe(60);
  });

  it("does not wait when it has not been asked for a while, and does not pace at all unless told to", async () => {
    const s = setup({ heavyPer10s: 10 });
    await s.rpc.call("getSignaturesForAddress", []);
    s.advance(30_000);
    await s.rpc.call("getSignaturesForAddress", []);
    expect(s.waits).toEqual([]); // time had passed: nothing to wait for
    const free = setup(undefined);
    for (let i = 0; i < 20; i++) await free.rpc.call("getSignaturesForAddress", []);
    expect(free.waits).toEqual([]);
    expect(free.rpc.heavyPerMinute).toBeNull();
    expect(PUBLIC_RPC_PACE).toEqual({ heavyPer10s: 9, lightPer10s: 35 });
  });

  it("stays away for as long as the RPC says after a refusal, and so does the next call of that kind", async () => {
    const s = setup({ heavyPer10s: 10, lightPer10s: 40 }, (n) => (n === 1 ? { status: 429, retryAfter: "10" } : { status: 200 }));
    expect(await s.rpc.call("getSignaturesForAddress", [])).toBe("getSignaturesForAddress");
    expect(s.started.map((x) => x.at)).toEqual([0, 10_000]); // refused at 0, tried again when it said
    await s.rpc.call("getTokenAccountsByOwner", []);
    expect(s.started.at(-1)!.at).toBe(11_000);
    // a call of the other kind was never held up by it
    const light = setup({ heavyPer10s: 10, lightPer10s: 40 }, (n) => (n === 1 ? { status: 429, retryAfter: "10" } : { status: 200 }));
    void light.rpc.call("getSignaturesForAddress", []);
    await light.rpc.call("getAccountInfo", []);
    expect(light.started.find((x) => x.method === "getAccountInfo")!.at).toBe(0);
  });

  it("takes the RPC's word for half a minute at most, and waits longer each time when it gives none", async () => {
    const long = setup({ heavyPer10s: 10 }, (n) => (n === 1 ? { status: 429, retryAfter: "3600" } : { status: 200 }));
    await long.rpc.call("getSignaturesForAddress", []);
    expect(long.started.map((x) => x.at)).toEqual([0, 30_000]);

    const silent = setup(undefined, (n) => (n <= 3 ? { status: 429 } : { status: 200 }));
    await silent.rpc.call("getTransaction", []);
    expect(silent.waits).toEqual([500, 1000, 2000]);

    // refused every time: it gives up and says so, and any other failure is said at once
    const never = setup(undefined, () => ({ status: 429 }));
    await expect(never.rpc.call("getTransaction", [])).rejects.toThrow("getTransaction: the RPC answered 429");
    expect(never.started).toHaveLength(5);
    const broken = setup({ heavyPer10s: 10 }, () => ({ status: 503 }));
    await expect(broken.rpc.call("getSignaturesForAddress", [])).rejects.toThrow("the RPC answered 503");
    expect(broken.started).toHaveLength(1);
    const wrong = setup(undefined, () => ({ status: 200, body: { error: { message: "Invalid param" } } }));
    await expect(wrong.rpc.call("getAccountInfo", [])).rejects.toThrow("getAccountInfo: Invalid param");
  });
});
