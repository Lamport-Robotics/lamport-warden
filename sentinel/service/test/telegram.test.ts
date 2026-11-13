/**
 * Telegram as a channel: the bot's few calls, the one-time codes that tie a chat to a profile, and what the
 * bot answers. Telegram itself is stood in for by a function that takes the calls and writes them down.
 */
import { describe, it, expect } from "vitest";
import { LINK_SECONDS, LinkCodes, SAID, TOKEN_SHAPE, TelegramBot, answer, chatOf, chatTarget, linkedTo, listen, type Incoming, type TelegramFetch } from "../src/telegram.js";

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

describe("after a restart", () => {
  it("leaves unread what was sent while nobody was listening, so nothing is answered twice", async () => {
    const asked: any[] = [];
    let round = 0;
    const t = telegram({ getUpdates: (body) => { asked.push(body); return { json: { ok: true, result: round++ === 0 ? [{ update_id: 41, message: { text: "/start old-code-from-before", chat: { id: 111 } } }] : [] } }; } });
    expect(await t.bot.skipWaiting()).toBe(true);
    expect(asked[0]).toEqual({ offset: -1, timeout: 0, allowed_updates: ["message"] }); // the last one only, which also marks all before it as seen
    expect(await t.bot.incoming(30)).toEqual([]);
    expect(asked[1].offset).toBe(42); // and that one is behind it too
    // nothing was waiting: nothing to skip, and that is fine
    const quiet = telegram({ getUpdates: () => ({ json: { ok: true, result: [] } }) });
    expect(await quiet.bot.skipWaiting()).toBe(true);
    // Telegram could not say: the caller is told, and does not start listening on a guess
    expect(await telegram({ getUpdates: () => ({ status: 401, json: { ok: false } }) }).bot.skipWaiting()).toBe(false);
    expect(await telegram({ getUpdates: () => "throw" }).bot.skipWaiting()).toBe(false);
  });
});

describe("where it has got to", () => {
  it("follows Telegram's numbering down as well as up, and asks without a number after a long quiet", async () => {
    const asked: any[] = [];
    const batches = [[{ update_id: 900, message: { text: "a", chat: { id: 1 } } }], [{ update_id: 17, message: { text: "b", chat: { id: 1 } } }], []];
    const t = telegram({ getUpdates: (body) => { asked.push(body); return { json: { ok: true, result: batches.shift() ?? [] } }; } });
    await t.bot.incoming(1);
    // after a week with nothing, Telegram may start again from any number: a lower one is still the newest
    expect(await t.bot.incoming(1)).toEqual([{ chat: "1", text: "b" }]);
    await t.bot.incoming(1);
    expect(asked.map((a) => a.offset)).toEqual([0, 901, 18]);
    // three days without a message: the next asking names no number, so whatever Telegram has is handed over
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 4 * 86_400_000;
      await t.bot.incoming(1);
      expect("offset" in asked.at(-1)).toBe(false);
    } finally { Date.now = realNow; }
  });

  it("says when a chat has a new number, as Telegram does for a group it made into a supergroup", async () => {
    const t = telegram({ sendMessage: () => ({ status: 400, json: { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001234567890 } } }) });
    expect(await t.bot.send("-4242", "x")).toEqual({ ok: false, status: 400, movedTo: "-1001234567890" });
    // and takes nothing that is not a number for one
    const odd = telegram({ sendMessage: () => ({ status: 400, json: { ok: false, parameters: { migrate_to_chat_id: "somewhere/else" } } }) });
    expect(await odd.bot.send("-4242", "x")).toEqual({ ok: false, status: 400 });
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
  const WALLETS = ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS"];
  function setup(linking: { ok: true; wallets: string[] } | { ok: false; why: string } = { ok: true, wallets: WALLETS.slice(0, 1) }) {
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
    // the chat is told which wallets it will hear about: someone sent a link by a stranger sees they are not theirs
    expect(await s.say(`/start ${code}`)).toBe("This chat now gets Warden Sentinel's alerts for the Sentinel profile that watches 7xKX..gAsU: one plain sentence each, never with a link, and never asking you to sign anything. If you did not ask for this on the Sentinel page yourself, or to end it, send /stop here.");
    expect(s.linked).toEqual([["alice", "111"]]);
    // the same link pressed again, by anyone: nothing
    expect(await s.say(`/start ${code}`, "666")).toBe(SAID.stale);
    expect(s.linked).toHaveLength(1);
    // in a group the command carries the bot's name
    expect(await s.say(`/start@WardenSentinelBot ${s.codes.issue("bob", T0)}`, "-100200")).toBe(linkedTo(WALLETS.slice(0, 1), true));
    expect(linkedTo(WALLETS, true)).toBe("This chat now gets Warden Sentinel's alerts for the Sentinel profile that watches 7xKX..gAsU and 9WzD..AWWM and 1 more: one plain sentence each, never with a link, and never asking you to sign anything. Whoever connected it can take it out again on the Sentinel page. If this group should not be getting them, remove this bot from the group.");
    expect(linkedTo([], false)).toContain("alerts for a Sentinel profile:");
    expect(linkedTo(WALLETS, false)).not.toMatch(/https?:|www\.|t\.me/);
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
    // in a group, /stop is anybody's to type and so is nobody's: the owner ends it on the page
    expect(await s.say("/stop", "-100200")).toBe(SAID.inGroup);
    expect(s.unlinked).not.toContain("-100200");
  });
});

describe("the listening", () => {
  it("answers each message, gives a chat five answers a minute, and keeps going when Telegram is away", async () => {
    const sent: [string, string][] = [];
    const waits: number[] = [];
    const logged: string[] = [], heard: string[] = [];
    const codes = new LinkCodes();
    const code = codes.issue("alice", T0);
    const batches: (Incoming[] | "down")[] = ["down", "down", [{ chat: "1", text: `/start ${code}` }, ...Array.from({ length: 8 }, () => ({ chat: "2", text: "hi" }))], [{ chat: "2", text: "hi" }]];
    let now = T0, running: { stop(): void; done: Promise<void> };
    const bot = {
      incoming: async () => { const b = batches.shift(); if (b === undefined) { running.stop(); return []; } if (b === "down") throw new Error("Telegram could not be reached"); return b; },
      send: async (chat: string, text: string) => { sent.push([chat, text]); return { ok: true, status: 200 }; },
    };
    running = listen({ bot, codes, link: async () => ({ ok: true as const, wallets: [] }), unlink: async () => false, now: () => now, wait: async (ms) => { waits.push(ms); }, log: (l) => logged.push(l), heard: (ok, why) => { heard.push(ok ? "yes" : `no: ${why}`); } });
    await running.done;
    expect(waits).toEqual([2000, 4000]); // slower each time, and back to quick once it answers
    expect(logged).toEqual(["sentinel: telegram: Telegram could not be reached; trying again in 2 s", "sentinel: telegram: Telegram could not be reached; trying again in 4 s"]);
    expect(sent.filter(([chat]) => chat === "1")).toEqual([["1", linkedTo([], false)]]);
    // and whoever started it was told, each time, whether Telegram answered
    expect(heard.slice(0, 3)).toEqual(["no: Telegram could not be reached", "no: Telegram could not be reached", "yes"]);
    expect(sent.filter(([chat]) => chat === "2")).toHaveLength(5); // nine messages, five answers
    // a minute later it is answered again
    now += 61;
    batches.push([{ chat: "2", text: "hi" }]);
    running = listen({ bot, codes, link: async () => ({ ok: true as const, wallets: [] }), unlink: async () => false, now: () => now, wait: async () => undefined, log: () => undefined });
    await running.done;
    expect(sent.filter(([chat]) => chat === "2")).toHaveLength(6);
  });
});
