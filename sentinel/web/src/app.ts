/**
 * The Sentinel page: sign in with a wallet, choose where alerts go, answer them, and link Warden.
 *
 * It holds nothing beyond the session (and, for a payment this tab sent, its signature, so that a reload
 * can still look for it): the session token lives in this tab's sessionStorage and goes out as
 * a bearer header, never as a cookie. Every piece of text that came from the server or a wallet is put on
 * the page with textContent, and the page's policy (index.html) lets no script run but this one.
 */
import { getWallets } from "@wallet-standard/app";
import { PAGE_ASKS, WARDEN_ANSWERS, type PageAnswer, type PageAsk } from "../../../src/sentinel-link.js";
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, PLANS, PRICE_CENTS, PRO_FEATURES, PRO_NOT_YET, RESCUE_TERMS, WATCH_FEATURES, decimal, grouped, lamportTerms, paceText, prepaidTerms, purchaseTerms, renewalTerms } from "../../service/src/plans.js";
import { dayOf } from "../../service/src/notices.js";
import { KNOWN_MINTS } from "../../../pincer1/daemon/src/tx/known.js";
import { LINK_STATEMENT, SIGN_IN_STATEMENT, signInText } from "../../service/src/signin-text.js";

const API = "/sentinel/api/v1";
const SESSION = "sentinel.session";

interface WalletRow { address: string; armed: boolean; reporting: boolean; paused: boolean; lastReadAt: number | null }
interface Me { profile: { id: string; tier: "watch" | "pro" }; wallets: WalletRow[]; channels: { id: string; kind: "ntfy" | "discord" | "slack" | "telegram"; hint: string; active: boolean; lastDeliveredAt: number | null; failing: { since: number; why: string } | null }[]; limits: { wallets: number; channels: number; kinds: string[]; pollSeconds: number; push?: boolean } }
interface Alert { id: string; wallet: string; at: number | null; level: "info" | "alert" | "urgent"; signals: string[]; sentence: string; answer: string | null; undelivered?: boolean; canRescue?: boolean }
/** Whether rescue can work here at all, whether this service can carry one out, whether the plan has it, and the profile's own switch. */
interface RescueInfo { available: boolean; on: boolean; plan: boolean; auto: boolean; chain: string | null }
interface TokenView { account: string; mint: string; amount: string; decimals: number }
interface RescueStanding { armed: boolean; ours: boolean; vault: string | null; rescuers: "lamport" | "own" | null; covered: TokenView[]; uncovered: (TokenView & { why: "not set up" | "frozen" | "cannot be moved"; other?: string })[] }
type Plan = { enabled: false } | { enabled: true; checkoutOpen: boolean; tier: string; subscribed: boolean; status: string | null; price: "full" | "holder"; cents: number; centsFull: number; centsHolder: number; holder: boolean; holderMin: number; renewsAt: number | null; endsAt: number | null; paidUntil?: number | null; crypto?: { payTo: string; assets: ("USDC" | "SOL" | "LAMPORT")[]; months: number[]; lamport?: { payTo: string; usd?: number | null } } | null };
type PayQuote = { reference: string; payTo: string; asset: "USDC" | "SOL" | "LAMPORT"; units: string; decimals: number; months: number; cents: number; expiresAt: number; /** Seconds left on it when the service answered, by the service's clock. */ left?: number; url: string; account?: string | null };
type Hello = Extract<PageAnswer, { type: "hello" }>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const b64 = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const utf8 = (s: string) => new TextEncoder().encode(s);
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const ago = (unix: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - unix); return s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129_600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86_400)} days ago`; };

let session: string | null = null;
try { session = sessionStorage.getItem(SESSION); } catch { /* a browser that keeps nothing: sign in each time */ }
let me: Me | null = null;
let alerts: Alert[] = [];
let plan: Plan = { enabled: false };
let warden: Hello | null = null;
let rescueInfo: RescueInfo | null = null;
/** How each wallet stood on the chain when this page last asked. */
const standings = new Map<string, RescueStanding>();

function say(text: string, bad = false): void { const n = $("notice"); n.textContent = text; n.className = bad ? "notice bad" : "notice"; n.hidden = text === ""; }
function keep(token: string | null): void { session = token; try { if (token) sessionStorage.setItem(SESSION, token); else sessionStorage.removeItem(SESSION); } catch { /* kept in memory only */ } }

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(`${API}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "omit", cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && session && path !== "/signin") { keep(null); me = null; render(); }
    return { status: res.status, body: json };
  } catch {
    return { status: 0, body: { error: "Sentinel could not be reached. Check your connection and try again." } };
  }
}
/** Runs a call and says what went wrong, in the server's own sentence. True when it worked. */
async function done(r: Promise<{ status: number; body: any }>, okText = ""): Promise<boolean> {
  const res = await r;
  if (res.status >= 200 && res.status < 300) { say(okText); return true; }
  say(String(res.body?.error ?? "That did not work."), true);
  return false;
}

// ---- wallets, through Wallet Standard

const registry = getWallets();
type AnyWallet = { name: string; icon: string; chains: readonly string[]; features: Record<string, any> };
const usable = (): AnyWallet[] => (registry.get() as unknown as AnyWallet[]).filter((w) => "standard:connect" in w.features && ("solana:signIn" in w.features || "solana:signMessage" in w.features) && w.chains.some((c) => c.startsWith("solana:")));

/** Has the wallet sign the sign-in text and sends it. Signing in, or adding the wallet to this profile. */
async function prove(wallet: AnyWallet, purpose: "signin" | "link"): Promise<{ status: number; body: any }> {
  const { accounts } = await wallet.features["standard:connect"].connect();
  const account = accounts?.[0];
  if (!account) return { status: 0, body: { error: "The wallet did not share an account." } };
  if (purpose === "link" && me?.wallets.some((w) => w.address === account.address)) return { status: 0, body: { error: "That wallet is already here. Switch to another account in your wallet, then try again." } };
  const attempt = async (own: boolean) => {
    const n = await call("POST", "/nonce", purpose === "link" ? { purpose: "link" } : {});
    if (n.status !== 200) return n;
    const issuedAt = new Date().toISOString();
    let message: Uint8Array, signature: Uint8Array, address: string = account.address;
    if (own) {
      // the wallet writes the text itself, and shows the site it is for
      const [out] = await wallet.features["solana:signIn"].signIn({ domain: n.body.host, address: account.address, statement: purpose === "link" ? LINK_STATEMENT : SIGN_IN_STATEMENT, nonce: n.body.nonce, issuedAt });
      message = out.signedMessage; signature = out.signature; address = out.account?.address ?? address;
    } else {
      const [out] = await wallet.features["solana:signMessage"].signMessage({ account, message: utf8(signInText({ host: n.body.host, address: account.address, nonce: n.body.nonce, purpose, issuedAt })) });
      message = out.signedMessage; signature = out.signature;
    }
    return call("POST", "/signin", { address, message: b64(message), signature: b64(signature) });
  };
  const hasOwn = "solana:signIn" in wallet.features, hasMessage = "solana:signMessage" in wallet.features;
  let r = await attempt(hasOwn);
  // a wallet that words its sign-in text another way: ask once more with the plain text
  if (r.status === 401 && hasOwn && hasMessage && /sign-in text|what this number was issued for/.test(String(r.body?.error))) r = await attempt(false);
  return r;
}

function choices(into: HTMLElement, purpose: "signin" | "link"): void {
  into.replaceChildren(...usable().map((w) => {
    const b = el("button");
    if (/^data:image\/(png|svg\+xml|webp|gif|jpeg);/.test(w.icon)) { const img = el("img"); img.src = w.icon; img.alt = ""; b.append(img); }
    b.append(el("span", purpose === "link" ? `Add a wallet from ${w.name}` : `Sign in with ${w.name}`));
    b.addEventListener("click", async () => {
      b.disabled = true;
      say(purpose === "link" ? "Your wallet will ask you to sign a short text. It adds that wallet here and moves nothing." : "Your wallet will ask you to sign a short text. It signs you in and moves nothing.");
      try {
        const r = await prove(w, purpose);
        if (r.status === 200) { if (typeof r.body.session === "string") keep(r.body.session); say(""); await refresh(); }
        else say(String(r.body?.error ?? "That did not work."), true);
      } catch (e) {
        say(/reject|denied|cancel|4001/i.test(String((e as Error)?.message ?? e)) ? "You closed the wallet's request, so nothing happened." : "The wallet could not sign that. Nothing happened.", true);
      }
      b.disabled = false;
    });
    return b;
  }));
}

// ---- Warden, the extension, when it is in this browser

let waiting: ((a: PageAnswer) => void) | null = null;
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const a = (e.data as Record<string, unknown> | null)?.[WARDEN_ANSWERS] as PageAnswer | undefined;
  if (a && waiting) { const w = waiting; waiting = null; w(a); }
});
function askWarden(ask: PageAsk): Promise<PageAnswer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting = null; resolve(null); }, 1200);
    waiting = (a) => { clearTimeout(timer); resolve(a); };
    window.postMessage({ [PAGE_ASKS]: ask }, location.origin);
  });
}
async function hello(): Promise<void> { const a = await askWarden({ type: "hello" }); warden = a && a.ok && a.type === "hello" ? a : null; }

// ---- drawing

/** A button that asks once more before it does something that cannot be taken back. */
function sure(label: string, again: string, act: () => Promise<void>): HTMLButtonElement {
  const b = el("button", label, "small danger");
  let armed = false;
  b.addEventListener("click", async () => {
    if (!armed) { armed = true; b.textContent = again; setTimeout(() => { armed = false; b.textContent = label; }, 4000); return; }
    b.disabled = true; await act(); b.disabled = false;
  });
  return b;
}
function row(title: string, detail: string, acts: HTMLElement[] = [], titleClass = ""): HTMLLIElement {
  const li = el("li"), what = el("div", "", "what"), b = el("b", title, titleClass);
  what.append(b, el("span", detail));
  li.append(what);
  if (acts.length) { const a = el("div", "", "acts"); a.append(...acts); li.append(a); }
  return li;
}

function render(): void {
  $("signedOut").hidden = !!me;
  $("signedIn").hidden = !me;
  $("signOut").hidden = !me;
  if (!me) {
    choices($("walletChoices"), "signin");
    $("noWallets").hidden = usable().length > 0;
    return;
  }
  const mine = me;

  $("wallets").replaceChildren(...mine.wallets.map((w) => {
    const state = w.paused ? "Paused: this plan watches fewer wallets than you have here." : w.lastReadAt ? `Watched, read every ${mine.limits.pollSeconds} seconds. Last read ${ago(w.lastReadAt)}.` : "Not read yet. The first read learns the wallet's history and can take a minute.";
    const li = row(w.address, state, [sure("Remove", "Remove and forget?", async () => { if (await done(call("DELETE", `/wallets/${w.address}`), "Removed.")) { if (warden?.linked.includes(w.address)) await askWarden({ type: "unlink", wallet: w.address }); await refresh(); } })], "addr");
    return li;
  }));
  $("walletLimit").textContent = `${mine.wallets.length} of ${mine.limits.wallets} wallets on this plan.`;
  // being told as it happens is the paid plan's: the free one is read in turn whatever the line is doing
  $("pace").textContent = paceText(mine.limits.pollSeconds, watching ? { push: watching.push && mine.limits.push === true, late: watching.late } : null);
  const add = $("addChoices");
  if (mine.wallets.length < mine.limits.wallets) choices(add, "link"); else add.replaceChildren();

  const kindName = { ntfy: "ntfy topic", discord: "Discord channel", slack: "Slack channel", telegram: "Telegram chat" } as const;
  $("channels").replaceChildren(...(mine.channels.length ? mine.channels.map((c) => {
    const acts: HTMLElement[] = [];
    if (c.active) {
      // so an owner knows an alert would reach them before they need one
      const test = el("button", "Send a test", "small");
      test.addEventListener("click", async () => { test.disabled = true; await done(call("POST", `/channels/${c.id}/test`), "Sent. If nothing arrives within a minute, the address is wrong or the app is not subscribed to it."); test.disabled = false; });
      acts.push(test);
    }
    acts.push(sure("Remove", "Remove?", async () => { if (await done(call("DELETE", `/channels/${c.id}`), "Removed.")) await refresh(); }));
    // a channel that has stopped taking messages is said here, with what it answered, before an alert is missed
    const standing = !c.active ? `${kindName[c.kind]}. Not in use: this plan does not cover it.`
      : c.failing ? `${kindName[c.kind]}. The last message could not be delivered here: ${c.failing.why}, first ${ago(c.failing.since)}. Send a test, or remove it and add one that works.`
      : `${kindName[c.kind]}. Alerts are sent here.${c.lastDeliveredAt ? ` The last message was delivered ${ago(c.lastDeliveredAt)}.` : ""}`;
    const li = row(c.hint, standing, acts, "addr");
    if (c.active && c.failing) li.classList.add("failing");
    return li;
  }) : [row("No channel yet", "Sentinel is watching, but it has nowhere to tell you. Alerts are still listed on this page.")]));
  // which kinds this plan takes, and whether the service has a Telegram bot to send through, come from the service
  const webhooks = mine.limits.kinds.includes("discord"), telegram = mine.limits.kinds.includes("telegram");
  $("channelLimit").textContent = webhooks
    ? `Up to ${mine.limits.channels} channels on this plan: ntfy topics, ${telegram ? "Telegram chats, " : ""}Discord webhooks and Slack webhooks.`
    : telegram ? "One channel on this plan: an ntfy topic or a Telegram chat. Pro adds Discord and Slack, and up to five channels." : "One ntfy channel on this plan. Pro adds Discord and Slack, and up to five channels.";
  $<HTMLInputElement>("ntfyTarget").placeholder = webhooks ? "An ntfy topic, or a Discord or Slack webhook address" : "https://ntfy.sh/a-long-topic-name";
  $("addTelegram").hidden = !telegram;
  $("telegramHelp").hidden = !telegram;

  const shown = alerts.slice(0, 50);
  $("events").replaceChildren(...(shown.length ? shown.map((a) => {
    const li = el("li"), what = el("div", "", "what"), head = el("b");
    head.append(el("span", a.level === "urgent" ? "Urgent" : a.level === "alert" ? "Alert" : "Note", `tag ${a.level}`), document.createTextNode(a.sentence));
    what.append(head, el("span", `${short(a.wallet)}${a.at ? ` · ${ago(a.at)}` : ""}${a.answer === "this_was_me" ? " · you said this was you" : a.answer === "ignore" ? " · ignored" : a.answer === "rescue" ? " · answered with a rescue" : ""}${a.undelivered ? " · not delivered: no channel took it" : ""}`));
    li.append(what);
    // a notice about the watching itself, or about a rescue, is not something the owner did or did not do: it has no answer
    const aboutWatching = Array.isArray(a.signals) && a.signals.some((s) => s === "watch_stopped" || s === "watch_resumed" || s === "rescued");
    if (!a.answer && a.level !== "info" && !aboutWatching) {
      const acts = el("div", "", "acts");
      // an alert that is reason enough on its own, about a wallet that is set up: the rescue is one press away
      if (a.canRescue && rescueInfo?.available && rescueInfo.on && rescueInfo.plan && mine.wallets.some((w) => w.address === a.wallet && w.armed)) {
        acts.append(sure("Rescue now", "Move it all to the vault?", async () => {
          const r = await call("POST", `/events/${a.id}/answer`, { answer: "rescue" });
          if (r.status === 200) { say(rescuedText(r.body)); standings.delete(a.wallet); await refresh(); } else say(String(r.body?.error ?? "That did not work."), true);
        }));
      }
      const was = el("button", "This was me", "small"), ignore = el("button", "Ignore", "small");
      was.addEventListener("click", async () => { if (await done(call("POST", `/events/${a.id}/answer`, { answer: "this_was_me" }), "Noted. Sentinel will treat who that paid as someone this wallet pays.")) await refresh(); });
      ignore.addEventListener("click", async () => { if (await done(call("POST", `/events/${a.id}/answer`, { answer: "ignore" }))) await refresh(); });
      acts.append(was, ignore);
      li.append(acts);
    }
    return li;
  }) : [row("Nothing so far", "When something looks wrong with a watched wallet, it is listed here and pushed to your channel.")]));

  // Warden
  $("wardenState").textContent = !warden ? "Warden is not in this browser, or is an older version. Sentinel works without it; it just cannot tell your own payments from anyone else's."
    : warden.reporting ? `Warden ${warden.version} is here, and "Tell Sentinel which signatures were mine" is on.`
    : `Warden ${warden.version} is here. To let it report, link a wallet below, then open Warden's settings and turn on "Tell Sentinel which signatures were mine".`;
  $("links").replaceChildren(...(warden ? mine.wallets.map((w) => {
    const here = warden!.linked.includes(w.address);
    const b = el("button", here ? "Unlink" : "Link this browser", "small");
    b.addEventListener("click", async () => {
      b.disabled = true;
      if (here) { await askWarden({ type: "unlink", wallet: w.address }); await done(call("DELETE", `/wallets/${w.address}/report-token`), "Unlinked."); }
      else {
        const r = await call("POST", `/wallets/${w.address}/report-token`);
        const a = r.status === 200 && typeof r.body.token === "string" ? await askWarden({ type: "link", wallet: w.address, token: r.body.token }) : null;
        say(a && a.ok ? (warden!.reporting ? "Linked. Warden will tell Sentinel when this wallet signs something you let through." : "Linked. Now turn on \"Tell Sentinel which signatures were mine\" in Warden's settings.") : "Warden did not take the link. Nothing changed.", !(a && a.ok));
      }
      await refresh();
    });
    return row(w.address, here ? "Linked from this browser." : w.reporting ? "Linked from another browser. Linking this one replaces that link." : "Not linked.", [b], "addr");
  }) : []));

  drawRescue(mine);
  plans(mine);
}

// ---- rescue

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A token by the name everybody knows it by, or by the ends of its address. */
const tokenLabel = (t: TokenView): string => `${decimal(BigInt(t.amount), t.decimals)} ${KNOWN_MINTS[t.mint]?.symbol ?? `of the token ${short(t.mint)}`}`;
/** What a rescue did. `gone`: accounts that were empty when the rescue reached them, which it did not empty. */
const rescuedText = (r: { moved?: number; failed?: number; gone?: number; vault?: string }): string => {
  const moved = Number(r.moved) || 0, failed = Number(r.failed) || 0, gone = Number(r.gone) || 0;
  if (moved + failed + gone === 0) return "There was nothing set up to move.";
  return (moved > 0 ? `Moved ${count(moved, "token account")} into your vault ${short(String(r.vault))}.` : "Nothing was moved.")
    + (failed > 0 ? ` ${count(failed, "account")} could not be moved and ${failed === 1 ? "is" : "are"} still in the wallet.` : "")
    + (gone > 0 ? ` ${count(gone, "account")} ${gone === 1 ? "was" : "were"} emptied by something else before the rescue reached ${gone === 1 ? "it" : "them"}.` : "");
};

function standingText(s: RescueStanding): string {
  const loose = s.uncovered.filter((u) => u.why === "not set up").length, frozen = s.uncovered.filter((u) => u.why === "frozen").length, fixed = s.uncovered.filter((u) => u.why === "cannot be moved").length;
  if (!s.armed) return `Not set up for rescue.${s.uncovered.length > 0 ? ` It holds ${count(s.uncovered.length, "token account")}.` : " It holds no tokens."}`;
  // a setup nobody asked for here: shown for what it is, and not something Sentinel acts on
  if (!s.ours) return `Set up for rescue into the vault ${short(s.vault ?? "")}, and not from this page. Sentinel will not rescue into it. If that vault is yours, press Use this vault. If it is not, take the setup away and treat this wallet's key as stolen.`;
  return `Set up for rescue into the vault ${short(s.vault ?? "")}. A rescue now would move ${count(s.covered.length, "token account")}.`
    + (loose > 0 ? ` ${count(loose, "account")} that hold${loose === 1 ? "s" : ""} something ${loose === 1 ? "is" : "are"} not covered: press Cover more tokens to choose.` : "")
    + (frozen > 0 ? ` ${count(frozen, "account")} ${frozen === 1 ? "is" : "are"} frozen and cannot be moved by anyone.` : "")
    + (fixed > 0 ? ` ${count(fixed, "account")} ${fixed === 1 ? "holds a token" : "hold tokens"} that an ordinary transfer cannot move, and ${fixed === 1 ? "is" : "are"} left out.` : "")
    + (s.rescuers === "own" ? " Only a key you named may start a rescue of this wallet, so Sentinel cannot." : "");
}

/** Asks the chain, through the service, how a wallet stands, and draws it. */
async function lookAt(wallet: string): Promise<RescueStanding | null> {
  const r = await call("GET", `/wallets/${wallet}/rescue`);
  if (r.status !== 200) { say(String(r.body?.error ?? "That could not be looked up just now."), true); return null; }
  standings.set(wallet, r.body as RescueStanding);
  if (me) drawRescue(me);
  return r.body as RescueStanding;
}

/**
 * Hands the transactions the service built to the wallet that holds `address`, one at a time. The service
 * built them and signed nothing: what they do is decided by the wallet's signature, and Warden, when it is
 * here, reads each one first like any other.
 *
 * After each one the service is asked again what is left (`next`), until the chain shows that the last one
 * landed. So every transaction is built when it is needed, on a recent blockhash, and the next is not asked
 * of the wallet before the one it depends on is on the chain. `next` answers null when it cannot say.
 */
function handToWallet(out: HTMLElement, address: string, first: string[], next: () => Promise<string[] | null>, lead: HTMLElement[], sent: () => Promise<void>): void {
  const pays = el("div", "", "choices");
  const wallets = (registry.get() as unknown as AnyWallet[]).filter((x) => "standard:connect" in x.features && "solana:signAndSendTransaction" in x.features && x.chains.some((c) => c.startsWith("solana:")));
  for (const w of wallets) {
    const b = el("button", `Sign with ${w.name}`, "solid");
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const { accounts } = await w.features["standard:connect"].connect();
        const account = accounts.find((a: { address: string }) => a.address === address);
        if (!account) { say(`${w.name} is not showing ${short(address)}. Switch it to that wallet, or choose the wallet that holds it.`, true); return; }
        let list = first, done = 0;
        const all = first.length;
        while (list.length > 0) {
          say(all > 1 ? `Waiting for the wallet: ${done + 1} of ${Math.max(all, done + list.length)}.` : "Waiting for the wallet.");
          await w.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain: rescueInfo?.chain ?? "solana:mainnet", transaction: Uint8Array.from(atob(list[0]!), (c) => c.charCodeAt(0)) });
          done += 1;
          if (list.length === 1 && all === 1) break;
          // the chain has to show that one before the next is built on it
          say("Sent. Waiting for the chain to show it…");
          let shorter: string[] | null = null;
          for (let i = 0; i < 12 && !shorter; i++) {
            await pause(2500);
            const again = await next();
            if (again && again.length < list.length) shorter = again;
          }
          if (!shorter) { out.hidden = true; say("Sent, and the chain does not show it yet, so the rest was not asked for. Press Look in a minute, and carry on from there."); return; }
          list = shorter;
        }
        out.hidden = true;
        await sent();
      } catch { say("The wallet did not send it. What was already sent stands; press Look to see how the wallet stands now.", true); } finally { b.disabled = false; }
    });
    pays.append(b);
  }
  if (wallets.length === 0) pays.append(el("p", "No wallet in this browser can be handed a transaction. Open this page in the browser that has the wallet.", "soft"));
  const close = el("button", "Not now", "small");
  close.addEventListener("click", () => { out.hidden = true; });
  out.replaceChildren(...lead, pays, close);
  out.hidden = false;
}

/** After the wallet sent something: the chain is asked a few times until it shows the change. */
async function settle(wallet: string, want: (s: RescueStanding) => boolean, okText: string): Promise<void> {
  say("Sent. Waiting for the chain to show it…");
  for (let i = 0; i < 8; i++) {
    await pause(2500);
    const s = await lookAt(wallet);
    if (s && want(s)) { say(okText); await refresh(); return; }
  }
  say("Sent, and the chain does not show it yet. Press Look in a minute.");
}

/**
 * The setup: rescue's own terms first, then which tokens, then the vault, then the wallet's signature.
 *
 * Which tokens is the owner's choice. A wallet collects tokens nobody asked for, each one set up costs a
 * deposit, and a token made to misbehave is one more thing a rescue has to get past: so the ones everybody
 * knows are ticked, and the rest are for the owner to tick.
 */
function openSetup(wallet: string, standing: RescueStanding): void {
  const out = $("rescueSetup");
  const ours = standing.armed && standing.ours;
  const head = el("p", `Set up ${short(wallet)} for rescue`, "plain");
  const terms = el("ul", "", "terms");
  terms.append(...RESCUE_TERMS.map((t) => el("li", t)));
  const agree = el("label", "", "soft"), agreed = el("input");
  agreed.type = "checkbox"; agreed.id = "rescueAgreed";
  const link = el("a", "terms");
  link.href = "/terms/#rescue"; link.target = "_blank"; link.rel = "noopener";
  agree.append(agreed, document.createTextNode(" I have read these lines, and agree to them and to the "), link, document.createTextNode("."));

  // which tokens: the ones that hold something, can be moved, and are not covered yet
  const open = standing.uncovered.filter((u) => u.why === "not set up");
  const pick = el("div", "", "pick");
  const boxes = new Map<string, HTMLInputElement>();
  if (open.length > 0) {
    pick.append(el("p", "Tick what a rescue should cover. Each token costs a small deposit to make room for it in your vault. A token you did not get yourself is best left out.", "soft"));
    for (const t of open) {
      const row = el("label"), box = el("input");
      box.type = "checkbox";
      // what everybody knows is ticked; anything else, and anything a setup would take a permission away from, is the owner's to tick
      box.checked = !!KNOWN_MINTS[t.mint] && !t.other;
      boxes.set(t.account, box);
      row.append(box, document.createTextNode(` ${tokenLabel(t)}${t.other ? `. ${short(t.other)} holds a permission on it now (a listing, perhaps): setting it up for rescue takes that away.` : ""}`));
      pick.append(row);
    }
  }
  const chosen = () => [...boxes].filter(([, b]) => b.checked).map(([a]) => a);

  const field = el("div", "", "field"), vault = el("input"), setUp = el("button", ours ? "Cover these tokens" : standing.armed ? "Use this vault" : "Build the setup", "solid");
  vault.type = "text"; vault.id = "rescueVault"; vault.spellcheck = false; vault.autocomplete = "off"; vault.placeholder = "The address of your Lamport Vault"; vault.setAttribute("aria-label", "Your Lamport Vault's address");
  // a wallet that is set up keeps its vault: only tokens are added
  if (ours && standing.vault) { vault.value = standing.vault; vault.readOnly = true; }
  setUp.id = "rescueBuild";
  setUp.disabled = !agreed.checked;
  agreed.addEventListener("change", () => { setUp.disabled = !agreed.checked; });
  field.append(vault, setUp);
  const close = el("button", "Not now", "small");
  close.addEventListener("click", () => { out.hidden = true; });
  setUp.addEventListener("click", async () => {
    if (!agreed.checked) return;
    const to = vault.value.trim(), accounts = chosen();
    const ask = () => call("POST", `/wallets/${wallet}/rescue/arm`, { vault: to, accounts, agreed: true });
    setUp.disabled = true;
    const r = await ask();
    setUp.disabled = false;
    if (r.status !== 200 || !Array.isArray(r.body?.transactions)) { say(String(r.body?.error ?? "That did not work."), true); return; }
    const transactions = r.body.transactions as string[];
    if (transactions.length === 0) { out.hidden = true; say(accounts.length > 0 || !standing.armed ? "Nothing to sign: what you chose is already covered." : "Sentinel will use that vault from now on."); await lookAt(wallet); await refresh(); return; }
    say("");
    const one = transactions.length === 1, makes = Number(r.body.makes) || 0;
    const what = el("p", `${count(transactions.length, "transaction")} to sign, one after another. ${one ? "It names" : "They name"} the vault ${short(String(r.body.vault))} and ${one ? "gives" : "give"} the rescue program permission on ${count(Number(r.body.accounts), "token account")}.${makes > 0 ? ` The first ${makes === 1 ? "makes a token account in your vault for one token" : `make a token account in your vault for each of ${makes} tokens`}, so that a rescue has somewhere to put ${makes === 1 ? "it" : "them"}: the network takes a small deposit in SOL for each, from this wallet.` : ""} Nothing in ${one ? "it" : "them"} moves a token.`, "plain");
    // Warden knows a rescue setup when it reads one, and holds it until the owner has looked at where a rescue would go
    const check = el("p", "Warden, if it is in this browser, will stop, name the vault a rescue would go to, and ask for the last four characters of its address. It should be exactly this one: ", "soft");
    check.append(el("code", String(r.body.vault), "addr"));
    const next = async () => { const again = await ask(); return again.status === 200 && Array.isArray(again.body?.transactions) ? again.body.transactions as string[] : null; };
    handToWallet(out, wallet, transactions, next, [head, what, check], () => settle(wallet, (s) => s.armed && s.ours && accounts.every((a) => s.covered.some((c) => c.account === a)), "Set up. A rescue of this wallet now goes into that vault."));
  });
  out.replaceChildren(head, terms, agree, pick, field, close);
  out.hidden = false;
  say("");
}

function drawRescue(mine: Me): void {
  const info = rescueInfo;
  $("rescueSection").hidden = !info?.available;
  if (!info?.available) return;
  $("rescueState").textContent = !info.plan ? "Rescue comes with Pro. A wallet that was set up before stays set up until you take the setup away, which you can do here on any plan."
    : info.on ? "Sentinel can rescue the wallets that are set up below."
    : "Sentinel cannot carry a rescue out right now: it can show how a wallet stands and build a setup, and nothing more.";
  $("rescueWallets").replaceChildren(...mine.wallets.map((w) => {
    const seen = standings.get(w.address) ?? null;
    // set up, and for the vault that was asked for here: what Sentinel acts on
    const ours = seen ? seen.armed && seen.ours : w.armed;
    const any = seen ? seen.armed : w.armed;
    const acts: HTMLElement[] = [];
    const look = el("button", "Look", "small");
    look.addEventListener("click", async () => { look.disabled = true; if (await lookAt(w.address)) say(""); look.disabled = false; });
    acts.push(look);
    if (info.plan) {
      const set = el("button", ours ? "Cover more tokens" : any ? "Use this vault" : "Set up", "small");
      set.addEventListener("click", async () => {
        set.disabled = true; const s = await lookAt(w.address); set.disabled = false;
        if (!s) return;
        openSetup(w.address, s);
        // a setup made elsewhere: the vault it names is filled in, for the owner to hold against their own
        if (s.armed && !s.ours && s.vault) { const v = $<HTMLInputElement>("rescueVault"); v.value = s.vault; v.readOnly = true; }
      });
      acts.push(set);
    }
    if (ours && info.on && info.plan) acts.push(sure("Rescue now", "Move it all to the vault?", async () => {
      const r = await call("POST", `/wallets/${w.address}/rescue/now`);
      if (r.status === 200) { say(rescuedText(r.body)); await lookAt(w.address); await refresh(); } else say(String(r.body?.error ?? "That did not work."), true);
    }));
    if (any) acts.push(sure("Take the setup away", "Take it away?", async () => {
      const ask = () => call("POST", `/wallets/${w.address}/rescue/disarm`);
      const r = await ask();
      if (r.status !== 200 || !Array.isArray(r.body?.transactions)) { say(String(r.body?.error ?? "That did not work."), true); return; }
      const transactions = r.body.transactions as string[], frozen = Number(r.body.frozen) || 0;
      const what = el("p", `${count(transactions.length, "transaction")} to sign, one after another. ${transactions.length === 1 ? "It closes the setup" : "The last closes the setup, and the others revoke every permission this wallet gave for rescue"}. After that nothing can rescue this wallet.${frozen > 0 ? ` ${count(frozen, "frozen account")} ${frozen === 1 ? "keeps its" : "keep their"} permission, because nobody can change a frozen account; once the setup is closed nothing can use it.` : ""}`, "plain");
      // once the setup is closed the service has nothing left to build: that is the end, not a failure
      const next = async () => { const again = await ask(); return again.status === 200 && Array.isArray(again.body?.transactions) ? again.body.transactions as string[] : again.status === 409 ? [] : null; };
      handToWallet($("rescueSetup"), w.address, transactions, next, [el("p", `Take the rescue setup away from ${short(w.address)}`, "plain"), what], () => settle(w.address, (s) => !s.armed, "Taken away. This wallet is no longer set up for rescue."));
    }));
    return row(w.address, seen ? standingText(seen) : any ? "Set up for rescue. Press Look to see what a rescue would move now." : "Not set up for rescue.", acts, "addr");
  }));
  const auto = $<HTMLInputElement>("rescueAuto");
  auto.checked = info.auto;
  // switching it off is always allowed; switching it on needs the plan and a service that can rescue
  auto.disabled = !info.auto && !(info.plan && info.on);
}

/**
 * Paying ahead in USDC or SOL. The amount comes from the service, with an address that marks the payment as
 * this profile's; it can be paid from a wallet in this browser or from any other, and the service finds it
 * on the chain. Nothing is taken on this page's word.
 */
/**
 * The box for paying ahead, kept from one drawing of the page to the next. The page draws itself again
 * every twenty seconds; a box made anew each time would lose the amount that was shown, the payment request
 * a phone is about to open, what was said about a payment being looked for, and the hold on the pay buttons
 * while it is. So the same box is put back for as long as what is offered is the same.
 */
let aheadKept: { key: string; box: HTMLElement; follow: (offer: Offer, cents: number) => void } | null = null;
type Offer = NonNullable<Extract<Plan, { enabled: true }>["crypto"]>;
/** How many times in a row an amount that ran out is brought up to date without anybody asking: half an hour's worth. */
const BROUGHT_UP_TO_DATE = 3;
/** `cents`: what a month costs this profile in dollars. An amount in LAMPORT is that, at the token's price. */
function payAhead(offer: Offer, lead: string, cents: number): HTMLElement {
  // (LAMPORT's price is left out of what makes the box the same box: it moves, and the box follows it)
  const key = JSON.stringify([{ ...offer, lamport: offer.lamport ? { payTo: offer.lamport.payTo } : null }, lead, me?.profile.id ?? null]);
  if (aheadKept?.key === key) { aheadKept.follow(offer, cents); return aheadKept.box; }
  const box = el("div", "", "ahead");
  const asset = el("select"), months = el("select");
  asset.setAttribute("aria-label", "Pay in");
  months.setAttribute("aria-label", "For how long");
  for (const a of offer.assets) { const o = el("option", a); o.value = a; asset.append(o); }
  for (const m of offer.months) { const o = el("option", m === 1 ? "1 month" : `${m} months`); o.value = String(m); months.append(o); }
  const show = el("button", "Show the amount");
  const pick = el("p", `${lead} `, "soft");
  pick.append(asset, document.createTextNode(" for "), months, document.createTextNode(" "), show);
  // About how many LAMPORT the plan comes to at the token's price now. It follows the price by itself, each
  // time the page draws itself again; the amount that binds is the one shown on asking, which holds ten minutes.
  const about = el("p", "", "soft about");
  let now = { usd: offer.lamport?.usd ?? null, cents };
  const estimate = () => {
    const n = Number(months.value);
    const tokens = asset.value === "LAMPORT" && now.usd && now.usd > 0 ? Math.ceil((now.cents * n) / 100 / now.usd) : 0;
    about.hidden = tokens <= 0;
    about.textContent = tokens > 0 ? `About ${tokens.toLocaleString("en-US")} LAMPORT for ${n === 1 ? "a month" : `${n} months`} at its price now. It follows the price: the exact amount is shown before you pay, and holds for ten minutes.` : "";
  };
  asset.addEventListener("change", estimate);
  months.addEventListener("change", estimate);
  estimate();
  const out = el("div", "", "quote");
  out.hidden = true;
  // While a payment that was handed to a wallet is being looked for, no other amount is shown: showing the
  // same one again would put the pay buttons back, and a second payment would be one press away.
  let held = false;
  const holdPicker = (on: boolean) => { held = on; show.disabled = on; asset.disabled = on; months.disabled = on; };
  /** Asks for an amount and shows it. `again`: how many times running it was brought up to date without anybody asking. */
  const ask = async (wanted: { asset: string; months: number }, again: number): Promise<void> => {
    if (held) return;
    show.disabled = true;
    // While an amount is being asked for, the one on the page is not handed to a wallet: the answer is about
    // to take its place, and the wallet would be paying an amount the page no longer shows.
    const live = Array.from(out.querySelectorAll<HTMLButtonElement>(".choices button")).filter((b) => !b.disabled);
    for (const b of live) b.disabled = true;
    const r = await call("POST", "/billing/crypto/quote", wanted);
    show.disabled = held;
    if (r.status !== 201 || typeof r.body?.reference !== "string") {
      for (const b of live) b.disabled = false;
      // an amount that nobody pressed for and could not be had is nothing to announce: the box already says how to ask
      if (again === 0) say(String(r.body?.error ?? "That did not work."), true);
      return;
    }
    quoted(out, r.body as PayQuote, holdPicker, { held: () => held, again, renew: () => ask(wanted, again + 1) });
  };
  show.addEventListener("click", () => void ask({ asset: asset.value, months: Number(months.value) }, 0));
  box.append(pick, about, out);
  aheadKept = { key, box, follow: (o, c) => { now = { usd: o.lamport?.usd ?? null, cents: c }; estimate(); } };
  return box;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Bytes as base58, the way a transaction's signature is written. */
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** How long a wallet is waited on: to say which account, and then to say what it did with the payment. A popup that was closed, or a wallet that never answers, must not hold the page for good. */
const WALLET_CONNECT_SECONDS = 120, WALLET_SIGN_SECONDS = 300;
class WalletSilent extends Error {}
function within<T>(work: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletSilent("the wallet did not answer")), seconds * 1000);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
/** The quotes a payment was announced for on this page: said once, whichever look found it. */
const announced = new Set<string>();
/** The payments this tab sent for a quote, by signature: kept for the tab, so that a reload can still look for them. */
function sentFor(reference: string): string[] {
  try { const kept = JSON.parse(sessionStorage.getItem(`sentinel:sent:${reference}`) ?? "[]"); return Array.isArray(kept) ? kept.filter((x) => typeof x === "string" && SIGNATURE.test(x)).slice(-5) : []; } catch { return []; }
}
function keepSent(reference: string, sent: string[]): void {
  try { sessionStorage.setItem(`sentinel:sent:${reference}`, JSON.stringify(sent.slice(-5))); } catch { /* the service looks by itself too */ }
}

/**
 * `life`: whether a payment is being looked for; how many times running this amount was brought up to date
 * without anybody asking; and how to ask for the amount again.
 */
function quoted(out: HTMLElement, q: PayQuote, holdPicker: (on: boolean) => void, life: { held: () => boolean; again: number; renew: () => Promise<void> }): void {
  // (which amount the box shows: a timer set for an earlier one finds it is not this one, and does nothing)
  out.dataset.reference = q.reference;
  // (a number of LAMPORT is in the tens of thousands: written with its thousands apart, as it is in the terms beside it)
  const lamport = q.asset === "LAMPORT";
  const amount = `${(lamport ? grouped : decimal)(BigInt(q.units), q.decimals)} ${q.asset}`;
  const line = el("p", `${life.again > 0 ? `The price of ${q.asset} moved on, and this is the amount now. If you paid the earlier amount as it ran out, do not pay again: it is still being looked for. ` : ""}The amount is exactly ${amount}, to `, "plain");
  line.append(el("code", q.payTo, "addr"), document.createTextNode(lamport ? ", Lamport's treasury wallet." : "."));
  // What marks a payment as this profile's is an address the button and the payment request put into it. A
  // send typed into a wallet has none, and nothing on the chain says whose it is: said before anybody does it.
  const how = el("p", "Pay it with a button here or with the payment request below: both mark the payment as yours. A send typed into a wallet by hand has no such mark, and is not counted by itself.", "soft how");
  // How long it holds, by the service's clock: so many seconds from its answer. This browser's own clock may be minutes out.
  const until = Date.now() + (typeof q.left === "number" && q.left >= 0 ? q.left : Math.max(0, q.expiresAt - Date.now() / 1000)) * 1000;
  // A wallet's prompt, and Warden's, name the token account a token lands in, and not the wallet it belongs
  // to. Said here, so that an address nobody mentioned is not what the payer meets in the prompt.
  const lands = q.account ? el("p", "In your wallet's prompt, and in Warden's, the receiving address is this wallet's own account for the token: ", "soft") : null;
  if (lands) {
    lands.append(el("code", q.account!, "addr"));
    if (lamport) lands.append(document.createTextNode(`. Warden gives the amount in the token's smallest units, a million to a token: ${q.units}.`));
  }
  const terms = el("ul", "", "terms");
  terms.append(...(lamport ? lamportTerms(q.cents, q.months) : prepaidTerms(q.cents, q.months)).map((t) => el("li", t)));
  if (q.asset !== "USDC") terms.append(el("li", `This price in ${q.asset} holds for ten minutes, until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Paid later than that, it is not counted: ask for the amount again.`));
  const status = el("p", "", "soft");
  const sent = sentFor(q.reference);
  // A payment made somewhere else is found by what names this quote on the chain. Its signature finds it whatever else is there.
  const byHand = el("input");
  byHand.placeholder = "The transaction's signature, if you have it"; byHand.setAttribute("aria-label", "Transaction signature"); byHand.autocomplete = "off"; byHand.spellcheck = false;
  const known = () => { const typed = byHand.value.trim(); return SIGNATURE.test(typed) ? [...sent, typed] : sent; };
  const look = el("button", "I have paid: look for it", "small");
  look.addEventListener("click", () => void watchFor(q, status, 1, known()));
  // a wallet in this browser can be handed the payment ready-made; any other wallet opens the request below
  const pays = el("div", "", "choices");
  const hold = (on: boolean) => { for (const x of Array.from(pays.querySelectorAll("button"))) x.disabled = on; holdPicker(on); };
  for (const w of (registry.get() as unknown as AnyWallet[]).filter((x) => "standard:connect" in x.features && "solana:signAndSendTransaction" in x.features && x.chains.some((c) => c.startsWith("solana:")))) {
    const b = el("button", `Pay with ${w.name}`, "solid");
    b.addEventListener("click", async () => {
      hold(true);
      /** True from the moment the wallet is handed the payment: after that, nothing here may say that nothing was sent. */
      let handed = false;
      try {
        const { accounts } = await within<{ accounts: any[] }>(w.features["standard:connect"].connect(), WALLET_CONNECT_SECONDS);
        const account = accounts[0];
        if (!account) throw new Error("the wallet gave no account");
        const made = await call("POST", "/billing/crypto/transaction", { reference: q.reference, payer: account.address });
        if (made.status !== 200 || typeof made.body?.transaction !== "string") { say(String(made.body?.error ?? "That did not work."), true); return; }
        let answer: unknown;
        handed = true;
        try {
          answer = await within<unknown>(w.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain: "solana:mainnet", transaction: Uint8Array.from(atob(made.body.transaction), (c) => c.charCodeAt(0)) }), WALLET_SIGN_SECONDS);
        } catch {
          // A wallet that says no has sent nothing. One that failed after it sent has, and nothing here can
          // tell the two apart: so it is looked for before anybody is asked to pay again.
          say("The wallet did not say it sent anything. If you approved it there, do not pay again: it is being looked for.", true);
          // a few seconds is how long a payment that did go out takes to show; after that the service itself refuses to build a second one over it
          await watchFor(q, status, 3, known(), "Nothing has shown up for it. If you said no in the wallet, nothing was sent. If you approved it there, look again in a minute before you pay again.");
          return;
        }
        const signature = (Array.isArray(answer) ? answer[0] : answer)?.signature;
        if (signature instanceof Uint8Array && signature.length === 64) { sent.push(base58(signature)); keepSent(q.reference, sent); }
        // nothing more is handed to a wallet for this quote while the payment just sent is being looked for
        await watchFor(q, status, 36, known());
      } catch (e) {
        if (handed) status.textContent = "That could not be looked up just now. If the wallet sent it, it is not lost: look for it with the button below.";
        else if (e instanceof WalletSilent) say("The wallet did not answer, and was not asked to pay anything. Open the wallet and try again.", true);
        else say("That did not work. The wallet was not asked for anything.", true);
      } finally { hold(false); }
    });
    pays.append(b);
  }
  const phone = el("p", "From a wallet on a phone, open this payment request: ", "soft");
  const request = el("input");
  request.readOnly = true; request.value = q.url; request.setAttribute("aria-label", "Payment request"); request.addEventListener("focus", () => request.select());
  phone.append(request);
  const found = el("p", "", "soft");
  found.append(look, document.createTextNode(" "), byHand);
  const parts: HTMLElement[] = [line, how, ...(lands ? [lands] : []), terms, pays, phone, found, status];
  out.replaceChildren(...parts);
  out.hidden = false;

  // An amount worked out from a price holds ten minutes. When it has run out and nothing was paid on it, it
  // is brought up to date by itself, so that what is on the page is an amount that can be paid: a few times
  // running while the page is being looked at, and after that on asking. An amount a payment is being
  // looked for on is left as it is.
  if (q.asset === "USDC") return;
  const over = () => { for (const x of Array.from(pays.querySelectorAll("button"))) x.disabled = true; };
  const mine = () => out.dataset.reference === q.reference && out.isConnected && !life.held();
  setTimeout(() => void (async () => {
    if (!mine()) return;
    // first, whether something was paid on it after all: from a phone, say
    const was = await watchFor(q, status, 1, known(), "");
    if (!mine()) return;
    over();
    if (was !== "waiting") return;
    status.textContent = `That amount has run out: the price of ${q.asset} has moved on. Press "Show the amount" for the amount now.`;
    // a payment made as it ran out is not final at that one look, and is counted up to five minutes late: it is asked about a while longer
    void trail(q, known);
    if (document.visibilityState === "visible" && life.again < BROUGHT_UP_TO_DATE) await life.renew();
  })(), Math.max(0, until - Date.now()) + 1500);
}

/** What somebody is told whose payment is at the treasury in full and did not come as their wallet's own transfer. */
const HELD = "The full amount arrived, but not as a transfer the paying wallet made itself: it came through a program, as from a multisig wallet. That is not counted by itself. Nothing is lost: write to support@lamportrobotics.com and it is counted by hand, or sent back.";
/** For how long after an amount ran out it is still asked about, and how often: the service counts a payment up to five minutes late, and the chain takes a little to make one final. */
const TRAIL_SECONDS = 360, TRAIL_EVERY_SECONDS = 60;
/**
 * Asks about an amount that ran out, quietly, after the page has moved on to the next one. Somebody who paid
 * from a phone in its last seconds is told so here, and not left looking at a new amount as if nothing had
 * been paid.
 */
async function trail(q: PayQuote, signatures: () => string[]): Promise<void> {
  for (let i = 0; i < TRAIL_SECONDS / TRAIL_EVERY_SECONDS; i++) {
    await new Promise((res) => setTimeout(res, TRAIL_EVERY_SECONDS * 1000));
    const r = await call("POST", "/billing/crypto/check", { reference: q.reference, signatures: signatures().slice(-5) });
    const s = r.status === 200 ? r.body?.status : null;
    if (s === "paid") {
      if (!announced.has(q.reference)) { announced.add(q.reference); say(`Paid: the payment made on the earlier amount was found. Your plan runs until ${dayOf(Number(r.body.until))}. If another amount is shown now, do not pay it.`); }
      await refresh();
      return;
    }
    if (s === "held") { say(`A payment on the earlier amount: ${HELD}`, true); return; }
    if (s === "short" || s === "late") { say(`A payment on the earlier amount arrived ${s === "short" ? "short" : "after it had run out"} and was not counted. Write to support@lamportrobotics.com to have it sent back or counted.`, true); return; }
  }
}

/** Asks the service whether the payment has arrived, every five seconds, so many times, and says what it found. A payment counts when the chain has made it final, which takes about a quarter of a minute. `signatures`: the payments this page knows were sent for it. */
async function watchFor(q: PayQuote, status: HTMLElement, times: number, signatures: string[] = [], notThere = "Not there yet. A payment counts once the chain has made it final; look again in a minute. The service also looks by itself every hour, and tells your alert channels when it finds it."): Promise<"paid" | "short" | "late" | "held" | "waiting" | "unread"> {
  for (let i = 0; i < times; i++) {
    status.textContent = "Looking for the payment on the chain…";
    const r = await call("POST", "/billing/crypto/check", { reference: q.reference, signatures: signatures.slice(-5) });
    const s = r.status === 200 ? r.body?.status : null;
    if (s === "paid") { status.textContent = ""; if (!announced.has(q.reference)) { announced.add(q.reference); say(`Paid. Your plan runs until ${dayOf(Number(r.body.until))}.`); } await refresh(); return "paid"; }
    if (s === "held") { status.textContent = HELD; return "held"; }
    if (s === "short") { status.textContent = `A payment arrived that is short: ${(q.asset === "LAMPORT" ? grouped : decimal)(BigInt(r.body.arrived), q.decimals)} ${q.asset} of ${(q.asset === "LAMPORT" ? grouped : decimal)(BigInt(r.body.wanted), q.decimals)}. Nothing was started. Write to support@lamportrobotics.com from the Terms page to have it sent back, or send the full amount.`; return "short"; }
    if (s === "late") { status.textContent = `A payment arrived after this price in ${q.asset} had run out, so it was not counted. Write to support@lamportrobotics.com to have it sent back or counted.`; return "late"; }
    if (r.status !== 200) { status.textContent = String(r.body?.error ?? "That could not be looked up just now."); return "unread"; }
    if (i < times - 1) await new Promise((res) => setTimeout(res, 5000));
  }
  status.textContent = notThere;
  return "waiting";
}

function plans(mine: Me): void {
  const paid = mine.profile.tier === "pro";
  const list = (items: readonly string[]) => { const ul = el("ul"); ul.append(...items.map((t) => el("li", t))); return ul; };
  const watch = el("div", "", paid ? "plan" : "plan mine");
  watch.append(el("h3", PLANS.watch.name), el("div", "Free", "price"), list(WATCH_FEATURES));
  if (!paid) watch.append(el("p", "This is your plan.", "soft"));

  const pro = el("div", "", paid ? "plan mine" : "plan");
  const p = plan.enabled ? plan : null;
  const centsFull = p?.centsFull ?? PRICE_CENTS, centsHolder = p?.centsHolder ?? HOLDER_PRICE_CENTS, holderMin = (p?.holderMin ?? HOLDER_MIN_LAMPORT).toLocaleString("en-US");
  const price = el("div", "", "price");
  price.append(document.createTextNode(money(p ? p.cents : centsFull)), el("small", " a month"));
  pro.append(el("h3", PLANS.pro.name), price);
  const features = list(["Everything in Watch", ...PRO_FEATURES]);
  features.append(
    el("li", p?.price === "holder" ? `You have the holder price: a wallet here holds ${holderMin} $LAMPORT. It is checked again each day.` : `${money(centsHolder)} a month, not ${money(centsFull)}, while a wallet in this profile holds ${holderMin} $LAMPORT`),
    el("li", PRO_NOT_YET, "not"),
  );
  pro.append(features);
  if (p?.subscribed) {
    // a cancelled plan is said to be ending, never to be renewing
    const b = el("button", p.endsAt ? "Keep the plan, or change card" : "Change card or cancel");
    b.addEventListener("click", async () => { b.disabled = true; const r = await call("POST", "/billing/portal"); if (r.status === 200 && typeof r.body.url === "string" && r.body.url.startsWith("https://billing.stripe.com/")) location.assign(r.body.url); else { say(String(r.body?.error ?? "That did not work."), true); b.disabled = false; } });
    const standing = p.endsAt
      ? `Cancelled. The plan runs until ${dayOf(p.endsAt)} and does not renew: nothing more is charged. After that your profile is on Watch, and nothing is deleted.`
      : `${renewalTerms(p.cents, centsFull, centsHolder, p.holderMin)}${p.renewsAt ? ` The next bill is on ${dayOf(p.renewsAt)}.` : ""}`;
    pro.append(b, el("p", p.status === "past_due" ? "Your last payment did not go through. Stripe is trying the card again; change it before the plan lapses." : "This is your plan.", "soft"), el("p", standing, "soft"));
  } else if (paid && p?.paidUntil) {
    // paid ahead in USDC or SOL: said with its last day, and never as something that renews
    pro.append(el("p", "This is your plan.", "soft"), el("p", `Paid until ${dayOf(p.paidUntil)}. It does not renew by itself: to keep it, pay again here before then. After that day your profile is on Watch, and nothing is deleted.`, "soft"));
    if (p.crypto) pro.append(payAhead(p.crypto, "Add time, paid in", p.cents));
  } else if (paid) {
    // on Pro without a subscription of its own: a plan that was given, not bought
    pro.append(el("p", "This is your plan.", "soft"));
  } else if (p?.checkoutOpen) {
    const b = el("button", `Start Pro for ${money(p.cents)} a month`, "solid");
    b.addEventListener("click", async () => { b.disabled = true; const r = await call("POST", "/billing/checkout"); if (r.status === 200 && typeof r.body.url === "string" && r.body.url.startsWith("https://checkout.stripe.com/")) location.assign(r.body.url); else { say(String(r.body?.error ?? "That did not work."), true); b.disabled = false; } });
    // everything that bears on the money, said before the button is pressed
    const terms = el("ul", "", "terms");
    terms.append(...purchaseTerms(p.cents, centsFull, centsHolder, p.holderMin).map((t) => el("li", t)));
    const agree = el("p", "Starting the plan means you agree to the ", "soft");
    const link = el("a", "terms");
    link.href = "/terms/";
    link.className = "ref";
    agree.append(link, ", which say the same and add how refunds work.");
    pro.append(b, terms, agree);
    if (p.crypto) pro.append(payAhead(p.crypto, "Or pay ahead, with no card, in", p.cents));
  } else {
    pro.append(el("p", "Not on sale yet.", "soft"));
  }
  $("plans").replaceChildren(watch, pro);
}

/** How the service is reading wallets right now, as far as it says: null when it did not say. */
let watching: { push: boolean; late: boolean } | null = null;

async function refresh(): Promise<void> {
  if (!session) { me = null; render(); return; }
  const [m, e, b, h, r] = await Promise.all([call("GET", "/me"), call("GET", "/events"), call("GET", "/billing"), call("GET", "/health"), call("GET", "/rescue")]);
  rescueInfo = r.status === 200 && typeof r.body?.available === "boolean" ? (r.body as RescueInfo) : rescueInfo;
  watching = h.status === 200 && h.body ? { push: h.body.push === "on", late: Number(h.body.late) > 0 } : null;
  if (m.status !== 200) { if (m.status !== 401) say(String(m.body?.error ?? "Sentinel could not be reached."), true); me = m.status === 401 ? null : me; render(); return; }
  me = m.body as Me;
  alerts = e.status === 200 && Array.isArray(e.body.events) ? e.body.events : alerts;
  plan = b.status === 200 ? (b.body as Plan) : plan;
  await hello();
  render();
}

$("signOut").addEventListener("click", async () => { await call("POST", "/signout"); keep(null); me = null; say("Signed out."); render(); });
$("makeTopic").addEventListener("click", () => {
  const raw = new Uint8Array(16); crypto.getRandomValues(raw);
  const topic = `sentinel-${Array.from(raw, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 24)}`;
  $<HTMLInputElement>("ntfyTarget").value = `https://ntfy.sh/${topic}`;
  say(`In the ntfy app, subscribe to the topic "${topic}", then press Add.`);
});
$("addChannel").addEventListener("click", async () => {
  if (await done(call("POST", "/channels", { target: $<HTMLInputElement>("ntfyTarget").value }), "Added. Alerts will be sent there.")) { $<HTMLInputElement>("ntfyTarget").value = ""; await refresh(); }
});

// A Telegram chat has no address to paste. The service hands out a link to its bot with a one-time code in it;
// the chat that presses Start there is the one alerts go to, and this page shows it once the bot has heard.
$("addTelegram").addEventListener("click", async () => {
  const r = await call("POST", "/channels/telegram");
  const url = typeof r.body?.url === "string" && r.body.url.startsWith("https://t.me/") ? r.body.url as string : null;
  if (r.status !== 201 || !url) { await done(Promise.resolve(r)); return; }
  const seconds = Number(r.body.seconds) || 900;
  const box = $("telegramLink"), link = el("a", "Open Telegram and press Start") as HTMLAnchorElement;
  link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
  box.replaceChildren(link, el("span", ` The link works once, for ${Math.round(seconds / 60)} minutes. This page shows the chat when it is connected.`));
  box.hidden = false;
  const before = me?.channels.length ?? 0, until = Date.now() + seconds * 1000;
  const look = async (): Promise<void> => {
    if (box.hidden) return;
    await refresh();
    if ((me?.channels.length ?? 0) > before) { box.hidden = true; say("Connected. Alerts will be sent to that chat."); return; }
    if (Date.now() < until) setTimeout(() => void look(), 4000); else box.hidden = true;
  };
  setTimeout(() => void look(), 4000);
});

$<HTMLInputElement>("rescueAuto").addEventListener("change", async (e) => {
  const box = e.target as HTMLInputElement, on = box.checked;
  box.disabled = true;
  const worked = await done(call("POST", "/rescue/auto", { on }), on ? "On. After a serious alert Sentinel rescues the wallets that are set up, and tells you afterwards." : "Off. Sentinel only alerts; a rescue happens when you press the button.");
  if (!worked) box.checked = !on;
  await refresh();
});

registry.on("register", () => { if (!me || me.wallets.length < me.limits.wallets) render(); });
// back from Stripe: the plan changes when Stripe tells the service, which can take a few seconds
const returned = new URLSearchParams(location.search).get("plan");
if (returned) { history.replaceState(null, "", location.pathname); if (returned === "started") { say("Stripe is confirming the payment. This page updates when it has."); for (const wait of [3000, 8000, 20_000]) setTimeout(() => void refresh(), wait); } else say("You left the checkout page, so nothing was charged."); }
setInterval(() => { if (me && document.visibilityState === "visible") void refresh(); }, 20_000);
render();
void refresh();
