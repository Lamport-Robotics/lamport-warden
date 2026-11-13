/**
 * Telegram as a place alerts go.
 *
 * An owner's other channels are addresses they paste in. A Telegram chat has no address to paste: the bot can
 * only write to a chat that has written to it first. So linking goes the other way round. The Sentinel page
 * hands the owner a one-time code inside a link to the bot; the owner presses Start in Telegram, which sends
 * the bot that code from their chat; the bot now knows which chat belongs to which profile.
 *
 * The bot reads its messages by asking for them (a long poll), so nothing has to be opened to the internet for
 * Telegram to reach. It answers three things and nothing else: a code, /stop, and anything else with one line
 * saying what it is for. It never sends a link, like every other message Sentinel sends.
 *
 * The bot's token is in the address of every call to Telegram. Nothing here logs or returns an address.
 */
import { createHash, randomBytes } from "node:crypto";

export type TelegramFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** What BotFather hands out: the bot's number, a colon, and a secret. */
export const TOKEN_SHAPE = /^\d{5,12}:[A-Za-z0-9_-]{30,60}$/;

/** A chat as a channel's stored address. Sealed in the data file like any other. */
export const chatTarget = (chat: string): string => `telegram:${chat}`;
/** The chat of such an address, or null when it is not one. A group's id is negative. */
export const chatOf = (target: string): string | null => /^telegram:(-?\d{1,20})$/.exec(target)?.[1] ?? null;

/** A zero-width space after "://", "www." and "@": the text reads the same, and Telegram makes nothing of it to tap. */
const ZW = "\u200b";
const plain = (s: string) => s.replace(/:\/\//g, `:${ZW}//`).replace(/\bwww\./gi, `www${ZW}.`).replace(/@/g, `@${ZW}`).replace(/(^|\s)([/#$])(?=[A-Za-z_])/g, `$1$2${ZW}`);

export interface Incoming { chat: string; text: string }

export class TelegramBot {
  private offset = 0;
  constructor(private token: string, private fetchImpl: TelegramFetch = (u, i) => fetch(u, i), private base = "https://api.telegram.org") {}

  private async call(method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<{ ok: boolean; status: number | null; result?: any }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      const json = await res.json().catch(() => null);
      return { ok: res.ok && json?.ok === true, status: res.status, result: json?.result };
    } catch {
      // whatever went wrong may carry the address, and the address carries the token: it is not passed on
      return { ok: false, status: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The name people find the bot by. Null when Telegram does not know the token, or cannot be reached. */
  async username(): Promise<string | null> {
    const r = await this.call("getMe", {});
    return r.ok && typeof r.result?.username === "string" && /^[A-Za-z0-9_]{3,40}$/.test(r.result.username) ? r.result.username : null;
  }

  /** One message to one chat, shown as plain characters: nothing in it becomes a link, a mention or a command. */
  async send(chat: string, text: string, quiet = false): Promise<{ ok: boolean; status: number | null }> {
    const r = await this.call("sendMessage", { chat_id: chat, text: plain(text).slice(0, 4000), disable_notification: quiet, link_preview_options: { is_disabled: true } });
    return { ok: r.ok, status: r.status };
  }

  /**
   * Leaves unread whatever was sent while nobody was listening. A code from before a restart is nobody's by
   * now, and the last messages before one would otherwise be answered a second time. False when Telegram
   * could not say.
   */
  async skipWaiting(): Promise<boolean> {
    const r = await this.call("getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message"] });
    if (!r.ok || !Array.isArray(r.result)) return false;
    for (const u of r.result) if (typeof u?.update_id === "number") this.offset = Math.max(this.offset, u.update_id + 1);
    return true;
  }

  /** Waits up to `seconds` for messages people sent the bot, and hands each over once. Throws when Telegram refuses. */
  async incoming(seconds = 50): Promise<Incoming[]> {
    const r = await this.call("getUpdates", { offset: this.offset, timeout: seconds, allowed_updates: ["message"] }, (seconds + 15) * 1000);
    if (!r.ok || !Array.isArray(r.result)) throw new Error(r.status === null ? "Telegram could not be reached" : `Telegram answered ${r.status}`);
    const out: Incoming[] = [];
    for (const u of r.result) {
      if (typeof u?.update_id === "number") this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u?.message;
      if (m && typeof m.text === "string" && (typeof m.chat?.id === "number" || typeof m.chat?.id === "string") && /^-?\d{1,20}$/.test(String(m.chat.id))) out.push({ chat: String(m.chat.id), text: m.text.slice(0, 200) });
    }
    return out;
  }
}

/** How long a link from the page is good for. */
export const LINK_SECONDS = 15 * 60;

/** The one-time codes that tie a chat to a profile. Kept in memory, as hashes: a restart ends them, and the owner asks for another. */
export class LinkCodes {
  private live = new Map<string, { profile: string; until: number }>();
  private static hash(code: string): string { return createHash("sha256").update(code).digest("hex"); }

  /** A new code for this profile. It has three at most at a time: the oldest gives way. */
  issue(profile: string, now: number): string {
    for (const [h, c] of this.live) if (c.until <= now) this.live.delete(h);
    const mine = [...this.live].filter(([, c]) => c.profile === profile);
    for (const [h] of mine.slice(0, Math.max(0, mine.length - 2))) this.live.delete(h);
    const code = randomBytes(18).toString("base64url");
    this.live.set(LinkCodes.hash(code), { profile, until: now + LINK_SECONDS });
    return code;
  }

  /** The profile a code was made for, once: a code that was used, has run out, or never was is nobody's. */
  take(code: string, now: number): string | null {
    const h = LinkCodes.hash(code);
    const c = this.live.get(h);
    if (!c) return null;
    this.live.delete(h);
    return c.until > now ? c.profile : null;
  }
}

export const SAID = {
  linked: "This chat now gets Warden Sentinel's alerts for your profile: one plain sentence each, never with a link, and never asking you to sign anything. Send /stop here to end it.",
  stale: "That link has run out or was already used. Press Connect Telegram on the Sentinel page for a new one.",
  stopped: "This chat no longer gets alerts from Warden Sentinel.",
  notLinked: "This chat was not getting alerts from Warden Sentinel.",
  inGroup: "In a group, alerts are stopped on the Sentinel page, by whoever connected the group there.",
  help: "I only deliver alerts from Warden Sentinel. To connect this chat, press Connect Telegram on the Sentinel page. I never send links and never ask you to sign anything.",
} as const;

export interface TelegramDeps {
  bot: Pick<TelegramBot, "incoming" | "send">;
  codes: LinkCodes;
  /** Makes the chat a channel of the profile. Answers with what to tell the chat when it would not. */
  link(profile: string, chat: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Stops alerts to the chat, whichever profiles it was a channel of. True when there was something to stop. */
  unlink(chat: string): Promise<boolean>;
  now?: () => number;
  log?: (line: string) => void;
  /** Waits between tries when Telegram cannot be reached (for tests). */
  wait?: (ms: number) => Promise<void>;
}

/** What one message to the bot leads to, and what the bot says back. */
export async function answer(message: Incoming, deps: Pick<TelegramDeps, "codes" | "link" | "unlink">, now: number): Promise<string> {
  // what the bot itself wrote and someone copied back carries the spaces that keep it from being tapped
  const text = message.text.replace(/\u200b/g, "").trim();
  // "/start CODE", and in a group "/start@TheBot CODE"
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
  if (start?.[1]) {
    const profile = /^[A-Za-z0-9_-]{16,64}$/.test(start[1]) ? deps.codes.take(start[1], now) : null;
    if (!profile) return SAID.stale;
    const linked = await deps.link(profile, message.chat);
    return linked.ok ? SAID.linked : linked.why;
  }
  if (/^\/stop(?:@\w+)?\s*$/.test(text)) {
    // A group has members who are not the owners that send their alerts to it, and any of them could type
    // this. Only a chat with one person in it can end its own alerts from inside. (A group's number is negative.)
    if (message.chat.startsWith("-")) return SAID.inGroup;
    return (await deps.unlink(message.chat)) ? SAID.stopped : SAID.notLinked;
  }
  return SAID.help;
}

/**
 * Reads what people send the bot, for as long as it runs. A chat gets five answers a minute at most, so nobody
 * can make the bot busy by talking to it. When Telegram cannot be reached it tries again, more and more slowly,
 * up to once a minute.
 */
export function listen(deps: TelegramDeps): { stop(): void; done: Promise<void> } {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? console.error;
  const answered = new Map<string, number[]>();
  let stopped = false, pause = 2000;
  const done = (async () => {
    while (!stopped) {
      let messages: Incoming[];
      try { messages = await deps.bot.incoming(); pause = 2000; } catch (e) {
        if (stopped) break;
        log(`sentinel: telegram: ${String((e as Error).message ?? e)}; trying again in ${Math.round(pause / 1000)} s`);
        await wait(pause);
        pause = Math.min(60_000, pause * 2);
        continue;
      }
      for (const message of messages) {
        const t = now();
        const recent = (answered.get(message.chat) ?? []).filter((at) => t - at < 60);
        if (recent.length >= 5) continue;
        answered.set(message.chat, [...recent, t]);
        try { await deps.bot.send(message.chat, await answer(message, deps, t)); } catch (e) { log(`sentinel: telegram: a message could not be answered (${String((e as Error).message ?? e)})`); }
      }
      if (answered.size > 5000) { const t = now(); for (const [chat, at] of answered) if (at.every((x) => t - x >= 60)) answered.delete(chat); }
    }
  })();
  return { stop: () => { stopped = true; }, done };
}
