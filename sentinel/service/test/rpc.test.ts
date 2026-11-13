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
  it("spaces each call an RPC rations evenly on an allowance of its own, and the rest together on a faster one", async () => {
    const s = setup({ heavyPer10s: 10, lightPer10s: 40 });
    for (let i = 0; i < 5; i++) await s.rpc.call("getSignaturesForAddress", []);
    expect(s.started.map((x) => x.at)).toEqual([0, 1000, 2000, 3000, 4000]); // one a second: never more than ten in ten
    // everything that is not rationed shares one lane, which has not been used: it starts at once, at its own pace
    const from = s.at();
    for (const method of ["getAccountInfo", "getBalance", "getAccountInfo"]) await s.rpc.call(method, []);
    expect(s.started.slice(5).map((x) => x.at - from)).toEqual([0, 250, 500]);
    // each rationed call has its own allowance: the first of another kind does not wait behind the listings
    expect([...HEAVY].sort()).toEqual(["getSignaturesForAddress", "getTokenAccountsByOwner", "getTransaction"]);
    const now = s.at();
    await s.rpc.call("getTokenAccountsByOwner", []);
    await s.rpc.call("getTransaction", []);
    expect(s.started.slice(-2).map((x) => x.at)).toEqual([now, now]);
    await s.rpc.call("getTransaction", []);
    expect(s.started.at(-1)!.at).toBe(now + 1000);
    expect(s.rpc.heavyPerMinute).toBe(60);
  });

  it("lets what cannot wait go ahead of what can", async () => {
    const s = setup({ heavyPer10s: 10 });
    const order: string[] = [];
    const call = (name: string, background: boolean) => s.rpc.call("getTransaction", [name], { background }).then(() => { order.push(name); });
    // a new wallet's history, three fetches deep, and then an alert's transaction arrives behind them
    const all = [call("history-1", true), call("history-2", true), call("history-3", true), call("alert", false)];
    await Promise.all(all);
    expect(order).toEqual(["history-1", "alert", "history-2", "history-3"]); // the first was already on its way; the alert took the next turn
    expect(s.at()).toBe(3000); // and the pace was kept all the same: four calls, a second apart
    // with nothing else asking, work that can wait is not held back at all
    const quiet = setup({ heavyPer10s: 10 });
    for (let i = 0; i < 3; i++) await quiet.rpc.call("getTransaction", [], { background: true });
    expect(quiet.started.map((x) => x.at)).toEqual([0, 1000, 2000]);
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
    await s.rpc.call("getSignaturesForAddress", []);
    expect(s.started.at(-1)!.at).toBe(11_000);
    // a call of the other kind was never held up by it
    const light = setup({ heavyPer10s: 10, lightPer10s: 40 }, (n) => (n === 1 ? { status: 429, retryAfter: "10" } : { status: 200 }));
    void light.rpc.call("getSignaturesForAddress", []);
    await light.rpc.call("getAccountInfo", []);
    expect(light.started.find((x) => x.method === "getAccountInfo")!.at).toBe(0);
  });

  it("a call that was already waiting its turn when the RPC said to stay away waits out the refusal too", async () => {
    // a clock the test moves by hand, and answers it gives when it chooses: the refusal has to land while the
    // second call is in the middle of waiting for its turn
    let t = 0;
    const sleepers: { until: number; wake: () => void }[] = [];
    const answers: ((r: { status: number; retryAfter?: string }) => void)[] = [];
    const startedAt: number[] = [];
    const fetchImpl: FetchLike = (_u, _i) => new Promise((resolve) => {
      startedAt.push(t);
      answers.push((r) => resolve({ ok: r.status < 300, status: r.status, json: async () => ({ result: "ok" }), headers: { get: (n) => (n.toLowerCase() === "retry-after" ? r.retryAfter ?? null : null) } }));
    });
    const rpc = new HttpRpc("https://rpc.example", fetchImpl, { pace: { heavyPer10s: 10 }, now: () => t, sleep: (ms) => new Promise<void>((wake) => { sleepers.push({ until: t + ms, wake }); }) });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const moveTo = async (to: number) => { t = to; for (const s of sleepers.splice(0)) { if (s.until <= t) s.wake(); else sleepers.push(s); } await settle(); };

    const first = rpc.call("getSignaturesForAddress", ["a"]);
    const second = rpc.call("getSignaturesForAddress", ["b"]);
    await settle();
    expect(startedAt).toEqual([0]); // the first is on its way; the second is counting down a second to its turn
    answers.shift()!({ status: 429, retryAfter: "10" });
    await settle();
    await moveTo(1000); // the second's turn comes round
    expect(startedAt).toEqual([0]); // and it is not sent into the closed window
    await moveTo(9999);
    expect(startedAt).toEqual([0]);
    await moveTo(10_000);
    expect(startedAt).toEqual([0, 10_000]);
    answers.shift()!({ status: 200 });
    await moveTo(11_000);
    expect(startedAt).toEqual([0, 10_000, 11_000]);
    answers.shift()!({ status: 200 });
    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
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
