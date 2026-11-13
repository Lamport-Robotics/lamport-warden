/**
 * Telegram as a channel: the bot's few calls, the one-time codes that tie a chat to a profile, and what the
 * bot answers. Telegram itself is stood in for by a function that takes the calls and writes them down.
 */
import { describe, it, expect } from "vitest";
import { LINK_SECONDS, LinkCodes, SAID, TOKEN_SHAPE, TelegramBot, answer, chatOf, chatTarget, listen, type Incoming, type TelegramFetch } from "../src/telegram.js";

const TOKEN = ["7123456789", "AAH" + "x".repeat(32)].join(":");
const T0 = 1_794_312_000;

function telegram(answers: Record<string, (body: any) => { status?: number; json: unknown } | "throw">) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetch: TelegramFetch = async (url, init) => {
    const method = url.split("/").at(-1)!;
    calls.push({ url, method, body: JSON.parse(init.body) });
    const a = answers[method]?.(JSON.parse(init.body)) ?? { json: { ok: true, result: {} } };
    if (a === "throw") throw new Error(`connect ECONNREFUSED ${url}`);
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, json: async () => a.json };
  };
  return { calls, bot: new TelegramBot(TOKEN, fetch) };
}

describe("the bot's calls", () => {
  it("knows a token by its shape and a chat by its address", () => {
    expect(TOKEN_SHAPE.test(TOKEN)).toBe(true);
    for (const bad of ["", "abc", "123:short", `${TOKEN} `, `bot${TOKEN}`, "7123456789:has spaces in it and is long enough to pass"]) expect(TOKEN_SHAPE.test(bad), bad).toBe(false);
    expect(chatTarget("12345")).toBe("telegram:12345");
    expect(chatOf("telegram:12345")).toBe("12345");
    expect(chatOf("telegram:-1001234567890")).toBe("-1001234567890"); // a group
    for (const bad of ["telegram:", "telegram:abc", "telegram:12 34", "https://t.me/x", "telegram:123456789012345678901"]) expect(chatOf(bad), bad).toBeNull();
  });

  it("learns its own name, or that the token is nobody's", async () => {
    const good = telegram({ getMe: () => ({ json: { ok: true, result: { id: 7, is_bot: true, username: "WardenSentinelBot" } } }) });
    expect(await good.bot.username()).toBe("WardenSentinelBot");
    expect(good.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(await telegram({ getMe: () => ({ status: 401, json: { ok: false, description: "Unauthorized" } }) }).bot.username()).toBeNull();
    expect(await telegram({ getMe: () => "throw" }).bot.username()).toBeNull();
    // a name that could not be part of a link is not taken as one
    expect(await telegram({ getMe: () => ({ json: { ok: true, result: { username: "x/../y?start=" } } }) }).bot.username()).toBeNull();
  });

  it("sends a sentence as plain characters: nothing in it can be tapped", async () => {
    const t = telegram({});
    expect(await t.bot.send("12345", "Warden Sentinel (7xKX..gAsU)\n25 USDC left your wallet. See https://evil.example and www.evil.example, ask @admin, /start now, #airdrop $SCAM", true)).toEqual({ ok: true, status: 200 });
    const sent = t.calls[0]!;
    expect(sent.method).toBe("sendMessage");
    expect(sent.body).toMatchObject({ chat_id: "12345", disable_notification: true, link_preview_options: { is_disabled: true } });
    expect(sent.body.parse_mode).toBeUndefined();
    const text: string = sent.body.text;
    for (const live of ["https://evil", "www.evil", "@admin", " /start", " #airdrop", " $SCAM"]) expect(text, live).not.toContain(live);
    // and it reads the same
    expect(text.replace(/\u200b/g, "")).toBe("Warden Sentinel (7xKX..gAsU)\n25 USDC left your wallet. See https://evil.example and www.evil.example, ask @admin, /start now, #airdrop $SCAM");
    // an amount is left as it is
    await t.bot.send("12345", "It sent $5 and 3 SOL.");
    expect(t.calls[1]!.body.text).toBe("It sent $5 and 3 SOL.");
    expect(t.calls[1]!.body.disable_notification).toBe(false);
  });

  it("says a chat that blocked it refused, and never lets the token out in what went wrong", async () => {
    expect(await telegram({ sendMessage: () => ({ status: 403, json: { ok: false, description: "Forbidden: bot was blocked by the user" } }) }).bot.send("1", "x")).toEqual({ ok: false, status: 403 });
    expect(await telegram({ sendMessage: () => ({ status: 200, json: { ok: false } }) }).bot.send("1", "x")).toEqual({ ok: false, status: 200 });
    expect(await telegram({ sendMessage: () => "throw" }).bot.send("1", "x")).toEqual({ ok: false, status: null });
    const down = telegram({ getUpdates: () => "throw" });
    const error = await down.bot.incoming(1).catch((e) => String(e.message));
    expect(error).toBe("Telegram could not be reached");
    expect(error).not.toContain(TOKEN.split(":")[1]);
    expect(await telegram({ getUpdates: () => ({ status: 409, json: { ok: false, description: "Conflict" } }) }).bot.incoming(1).catch((e) => String(e.message))).toBe("Telegram answered 409");
  });

  it("hands over each message once, and only ones it can use", async () => {
    let round = 0;
    const t = telegram({ getUpdates: () => ({ json: { ok: true, result: round++ === 0 ? [
      { update_id: 10, message: { text: "/start abc", chat: { id: 111, type: "private" } } },
      { update_id: 11, message: { photo: [], chat: { id: 111 } } }, // no text
      { update_id: 12, edited_message: { text: "hi", chat: { id: 5 } } },
      { update_id: 13, message: { text: "x".repeat(5000), chat: { id: -100123, type: "supergroup" } } },
      { update_id: 14, message: { text: "hi", chat: { id: "not a number" } } },
    ] : [] } }) });
    expect(await t.bot.incoming(30)).toEqual([{ chat: "111", text: "/start abc" }, { chat: "-100123", text: "x".repeat(200) }]);
    expect(t.calls[0]!.body).toEqual({ offset: 0, timeout: 30, allowed_updates: ["message"] });
    expect(await t.bot.incoming(30)).toEqual([]);
    expect(t.calls[1]!.body.offset).toBe(15); // past everything it was shown, usable or not
  });
});

describe("the one-time codes", () => {
  it("tie one chat to one profile, once, for a quarter of an hour", () => {
    const codes = new LinkCodes();
    const a = codes.issue("alice", T0), b = codes.issue("bob", T0);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
    expect(codes.take(a, T0 + 10)).toBe("alice");
    expect(codes.take(a, T0 + 11)).toBeNull(); // used
    expect(codes.take("nonsense", T0)).toBeNull();
    expect(codes.take(b, T0 + LINK_SECONDS)).toBeNull(); // run out
    const late = codes.issue("bob", T0);
    expect(codes.take(late, T0 + LINK_SECONDS - 1)).toBe("bob");
  });

  it("are three at most for a profile, the oldest giving way, and are not kept as themselves", () => {
    const codes = new LinkCodes();
    const made = [1, 2, 3, 4].map((i) => codes.issue("alice", T0 + i));
    const other = codes.issue("bob", T0);
    expect(codes.take(made[0]!, T0 + 10)).toBeNull();
    for (const c of made.slice(1)) expect(codes.take(c, T0 + 10)).toBe("alice");
    expect(codes.take(other, T0 + 10)).toBe("bob");
    const fresh = new LinkCodes();
    const code = fresh.issue("alice", T0);
    expect(JSON.stringify([...(fresh as unknown as { live: Map<string, unknown> }).live])).not.toContain(code);
  });
});

describe("what the bot answers", () => {
  function setup(linking: { ok: true } | { ok: false; why: string } = { ok: true }) {
    const codes = new LinkCodes();
    const linked: [string, string][] = [], unlinked: string[] = [];
    const channels = new Set<string>();
    const deps = {
      codes,
      link: async (profile: string, chat: string) => { linked.push([profile, chat]); if (linking.ok) channels.add(chat); return linking; },
      unlink: async (chat: string) => { unlinked.push(chat); return channels.delete(chat); },
    };
    return { codes, linked, unlinked, deps, say: (text: string, chat = "111") => answer({ chat, text }, deps, T0 + 5) };
  }

  it("links the chat a good code came from, and says so", async () => {
    const s = setup();
    const code = s.codes.issue("alice", T0);
    expect(await s.say(`/start ${code}`)).toBe(SAID.linked);
    expect(s.linked).toEqual([["alice", "111"]]);
    // the same link pressed again, by anyone: nothing
    expect(await s.say(`/start ${code}`, "666")).toBe(SAID.stale);
    expect(s.linked).toHaveLength(1);
    // in a group the command carries the bot's name
    expect(await s.say(`/start@WardenSentinelBot ${s.codes.issue("bob", T0)}`, "-100200")).toBe(SAID.linked);
    expect(s.linked[1]).toEqual(["bob", "-100200"]);
  });

  it("says why when the profile cannot take the chat, in the profile's own words", async () => {
    const s = setup({ ok: false, why: "This profile already has as many channels as its plan allows." });
    expect(await s.say(`/start ${s.codes.issue("alice", T0)}`)).toBe("This profile already has as many channels as its plan allows.");
  });

  it("stops on /stop, and says what it is for to anything else, never with a link", async () => {
    const s = setup();
    await s.say(`/start ${s.codes.issue("alice", T0)}`);
    expect(await s.say("/stop")).toBe(SAID.stopped);
    expect(await s.say("/stop")).toBe(SAID.notLinked);
    expect(await s.say("/\u200bstop")).toBe(SAID.notLinked); // copied back from the bot's own message
    for (const other of ["/start", "hello", "/start not a code!", "/help", "send me your seed phrase", `/start ${"x".repeat(100)}`]) expect([SAID.help, SAID.stale]).toContain(await s.say(other));
    expect(await s.say("/start")).toBe(SAID.help);
    expect(s.linked).toHaveLength(1);
    for (const sentence of Object.values(SAID)) expect(sentence).not.toMatch(/https?:|www\.|t\.me/);
  });
});

describe("the listening", () => {
  it("answers each message, gives a chat five answers a minute, and keeps going when Telegram is away", async () => {
    const sent: [string, string][] = [];
    const waits: number[] = [];
    const logged: string[] = [];
    const codes = new LinkCodes();
    const code = codes.issue("alice", T0);
    const batches: (Incoming[] | "down")[] = ["down", "down", [{ chat: "1", text: `/start ${code}` }, ...Array.from({ length: 8 }, () => ({ chat: "2", text: "hi" }))], [{ chat: "2", text: "hi" }]];
    let now = T0, running: { stop(): void; done: Promise<void> };
    const bot = {
      incoming: async () => { const b = batches.shift(); if (b === undefined) { running.stop(); return []; } if (b === "down") throw new Error("Telegram could not be reached"); return b; },
      send: async (chat: string, text: string) => { sent.push([chat, text]); return { ok: true, status: 200 }; },
    };
    running = listen({ bot, codes, link: async () => ({ ok: true }), unlink: async () => false, now: () => now, wait: async (ms) => { waits.push(ms); }, log: (l) => logged.push(l) });
    await running.done;
    expect(waits).toEqual([2000, 4000]); // slower each time, and back to quick once it answers
    expect(logged).toEqual(["sentinel: telegram: Telegram could not be reached; trying again in 2 s", "sentinel: telegram: Telegram could not be reached; trying again in 4 s"]);
    expect(sent.filter(([chat]) => chat === "1")).toEqual([["1", SAID.linked]]);
    expect(sent.filter(([chat]) => chat === "2")).toHaveLength(5); // nine messages, five answers
    // a minute later it is answered again
    now += 61;
    batches.push([{ chat: "2", text: "hi" }]);
    running = listen({ bot, codes, link: async () => ({ ok: true }), unlink: async () => false, now: () => now, wait: async () => undefined, log: () => undefined });
    await running.done;
    expect(sent.filter(([chat]) => chat === "2")).toHaveLength(6);
  });
});
