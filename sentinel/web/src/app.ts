/**
 * The Sentinel page: sign in with a wallet, choose where alerts go, answer them, and link Warden.
 *
 * It holds nothing beyond the session: the session token lives in this tab's sessionStorage and goes out as
 * a bearer header, never as a cookie. Every piece of text that came from the server or a wallet is put on
 * the page with textContent, and the page's policy (index.html) lets no script run but this one.
 */
import { getWallets } from "@wallet-standard/app";
import { PAGE_ASKS, WARDEN_ANSWERS, type PageAnswer, type PageAsk } from "../../../src/sentinel-link.js";
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, PLANS, PRICE_CENTS, PRO_FEATURES, PRO_NOT_YET, WATCH_FEATURES, paceText, purchaseTerms, renewalTerms } from "../../service/src/plans.js";
import { dayOf } from "../../service/src/notices.js";
import { LINK_STATEMENT, SIGN_IN_STATEMENT, signInText } from "../../service/src/signin-text.js";

const API = "/sentinel/api/v1";
const SESSION = "sentinel.session";

interface WalletRow { address: string; armed: boolean; reporting: boolean; paused: boolean; lastReadAt: number | null }
interface Me { profile: { id: string; tier: "watch" | "pro" }; wallets: WalletRow[]; channels: { id: string; kind: "ntfy" | "discord" | "slack" | "telegram"; hint: string; active: boolean; lastDeliveredAt: number | null; failing: { since: number; why: string } | null }[]; limits: { wallets: number; channels: number; kinds: string[]; pollSeconds: number; push?: boolean } }
interface Alert { id: string; wallet: string; at: number | null; level: "info" | "alert" | "urgent"; signals: string[]; sentence: string; answer: string | null; undelivered?: boolean }
type Plan = { enabled: false } | { enabled: true; checkoutOpen: boolean; tier: string; subscribed: boolean; status: string | null; price: "full" | "holder"; cents: number; centsFull: number; centsHolder: number; holder: boolean; holderMin: number; renewsAt: number | null; endsAt: number | null };
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
    what.append(head, el("span", `${short(a.wallet)}${a.at ? ` · ${ago(a.at)}` : ""}${a.answer === "this_was_me" ? " · you said this was you" : a.answer === "ignore" ? " · ignored" : ""}${a.undelivered ? " · not delivered: no channel took it" : ""}`));
    li.append(what);
    // a notice about the watching itself is not something the owner did or did not do: it has no answer
    const aboutWatching = Array.isArray(a.signals) && a.signals.some((s) => s === "watch_stopped" || s === "watch_resumed");
    if (!a.answer && a.level !== "info" && !aboutWatching) {
      const acts = el("div", "", "acts");
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

  plans(mine);
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
  } else {
    pro.append(el("p", "Not on sale yet.", "soft"));
  }
  $("plans").replaceChildren(watch, pro);
}

/** How the service is reading wallets right now, as far as it says: null when it did not say. */
let watching: { push: boolean; late: boolean } | null = null;

async function refresh(): Promise<void> {
  if (!session) { me = null; render(); return; }
  const [m, e, b, h] = await Promise.all([call("GET", "/me"), call("GET", "/events"), call("GET", "/billing"), call("GET", "/health")]);
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

registry.on("register", () => { if (!me || me.wallets.length < me.limits.wallets) render(); });
// back from Stripe: the plan changes when Stripe tells the service, which can take a few seconds
const returned = new URLSearchParams(location.search).get("plan");
if (returned) { history.replaceState(null, "", location.pathname); if (returned === "started") { say("Stripe is confirming the payment. This page updates when it has."); for (const wait of [3000, 8000, 20_000]) setTimeout(() => void refresh(), wait); } else say("You left the checkout page, so nothing was charged."); }
setInterval(() => { if (me && document.visibilityState === "visible") void refresh(); }, 20_000);
render();
void refresh();
