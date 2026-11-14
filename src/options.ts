/** The settings page. Everything is built with textContent: stored addresses and labels are never parsed as HTML. */
import { DEFAULT_RPC, PRACTICE_PAGE, SENTINEL_PAGE } from "./defaults.js";
import { LINK_PREFIX, linkFrom } from "./sentinel-link.js";
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, PLANS, PRICE_CENTS, PRO_FEATURES, PRO_NOT_YET, WATCH_FEATURES } from "../sentinel/service/src/plans.js";
import { KEYS, cleanAddress, cleanOrigin, cleanRpcUrl, settingsFrom } from "./settings.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const note = (id: string, text: string, bad = false) => { const n = $(id); n.textContent = text; n.className = bad ? "note bad" : "note"; };
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString();

async function load() {
  const all = await chrome.storage.local.get(null);
  const s = settingsFrom(all);
  $("version").textContent = `Version ${chrome.runtime.getManifest().version}`;

  // the practice page: a link, here and in the welcome a new install sees. Nothing is fetched until it is pressed.
  $<HTMLAnchorElement>("practice").href = PRACTICE_PAGE;
  const practice = $<HTMLAnchorElement>("practiceLink");
  practice.href = PRACTICE_PAGE;
  practice.textContent = PRACTICE_PAGE.replace(/^https:\/\//, "");
  const welcome = new URLSearchParams(location.search).get("welcome") === "1";
  $("welcome").hidden = !welcome;
  $("practiceLine").hidden = welcome;

  // lookup tables
  // compared as the settings store writes addresses (a trailing slash and all), not as the constant is spelled
  // both sides, because nothing stored yet is the constant itself: a new install is on the public RPC, and says so
  const mode = s.rpcUrl === "" ? "off" : cleanRpcUrl(s.rpcUrl) === cleanRpcUrl(DEFAULT_RPC) ? "public" : "own";
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="rpc"]')) r.checked = r.value === mode;
  $<HTMLInputElement>("rpcUrl").value = mode === "own" ? s.rpcUrl : "";

  // a decoy first
  $<HTMLInputElement>("decoyFirst").checked = s.decoyFirst;
  $<HTMLInputElement>("decoyAddress").value = s.decoyAddress;
  if (s.decoyFirst && !s.decoyAddress) note("decoyNote", "On, and there is no decoy to show: give its address below. Until then every site is connected as always.", true);
  else if (s.decoyFirst && s.rpcUrl === "") note("decoyNote", "On. The RPC is turned off above, so Warden cannot ask what the decoy holds: a thief is then caught by what it asks for, and not by how much.", true);

  // simulation
  $<HTMLInputElement>("simulate").checked = s.simulate;
  if (s.simulate && s.rpcUrl === "") note("simNote", "Simulation needs an RPC, and the RPC is turned off above. Nothing is simulated.", true);

  // Privacy Rings sites
  const sites = $("sites");
  sites.replaceChildren();
  if (s.ringSites.length === 0) sites.append(el("li", "No site is allowed."));
  for (const site of s.ringSites) {
    const li = el("li");
    const rm = el("button", "Remove", "small");
    rm.addEventListener("click", async () => { await chrome.storage.local.set({ ringSites: s.ringSites.filter((x) => x !== site) }); await load(); });
    li.append(el("span", site), rm);
    sites.append(li);
  }

  // doors that could not be guarded
  const doors = all.unguarded && typeof all.unguarded === "object" ? Object.entries(all.unguarded as Record<string, unknown>).filter(([, d]) => typeof d === "string").sort() : [];
  $("doors").hidden = doors.length === 0;
  $("doorList").replaceChildren(...doors.map(([name, seen]) => { const li = el("li"); li.append(el("span", `window.${name}`), el("span", `last seen ${String(seen)}`, "soft")); return li; }));

  // Sentinel: what this browser saw each wallet set up (sentinel.ts keeps it), and which wallets report
  const page = $<HTMLAnchorElement>("sentinelPage");
  page.href = SENTINEL_PAGE;
  page.textContent = SENTINEL_PAGE.replace(/^https:\/\//, "");
  $<HTMLInputElement>("reportSigned").checked = s.reportSigned;
  // what Sentinel costs and gives, from the same definition the service enforces
  const dollars = (cents: number) => `$${cents / 100}`;
  const listOf = (items: readonly string[]) => { const ul = el("ul", "", "plain"); ul.append(...items.map((t) => el("li", t))); return ul; };
  $("sentinelPlans").replaceChildren(
    el("p", `Warden is free and stays free. Sentinel has two plans. ${PLANS.watch.name} is free:`),
    listOf(WATCH_FEATURES),
    el("p", `${PLANS.pro.name} is ${dollars(PRICE_CENTS)} a month, or ${dollars(HOLDER_PRICE_CENTS)} while a wallet in your Sentinel profile holds ${HOLDER_MIN_LAMPORT.toLocaleString("en-US")} $LAMPORT. It adds:`),
    listOf(PRO_FEATURES),
    el("p", PRO_NOT_YET),
    el("p", "A plan is started and cancelled on the Sentinel page, which also says whether Pro is on sale. It is paid by card through Stripe; nothing is bought inside this extension."),
  );
  const armed = new Map<string, { vault: string; pending: boolean }>();
  for (const [k, v] of Object.entries(all)) {
    const state = v as { vault?: unknown; pendingVault?: unknown } | null;
    if (k.startsWith("sentinel:") && state && typeof state.vault === "string") armed.set(k.slice(9), { vault: state.vault, pending: typeof state.pendingVault === "string" });
  }
  const linked = new Set(Object.keys(all).filter((k) => k.startsWith(LINK_PREFIX) && linkFrom(all[k])).map((k) => k.slice(LINK_PREFIX.length)));
  const sentinel = $("sentinelWallets");
  sentinel.replaceChildren();
  const known = [...new Set([...armed.keys(), ...linked])].sort();
  if (known.length === 0) sentinel.append(el("li", "No wallet in this browser is set up with Sentinel."));
  for (const wallet of known) {
    const li = el("li");
    const a = armed.get(wallet);
    const says = [
      a ? `armed: a rescue moves its tokens to your vault ending ${a.vault.slice(-4)}${a.pending ? ", and a change of vault is waiting" : ""}` : "not armed in this browser",
      linked.has(wallet) ? (s.reportSigned ? "reports its signatures" : "linked, but reporting is off") : "does not report",
    ];
    const name = el("span", short(wallet), "addr");
    name.title = wallet;
    li.append(name, el("span", says.join("; "), "soft"));
    if (linked.has(wallet)) {
      const rm = el("button", "Unlink", "small");
      rm.addEventListener("click", async () => { await chrome.storage.local.remove(`${LINK_PREFIX}${wallet}`); await load(); });
      li.append(rm);
    }
    sentinel.append(li);
  }

  // history
  const memory = $("memory");
  memory.replaceChildren();
  const wallets = Object.keys(all).filter((k) => k.startsWith("memory:")).sort();
  if (wallets.length === 0) memory.append(el("p", "Nothing yet.", "soft"));
  for (const key of wallets) {
    const state = all[key] as MemoryState | undefined;
    const paid = Object.values(state?.counterparties ?? {}).sort((a, b) => b.lastSeen - a.lastSeen);
    const d = el("details");
    d.append(el("summary", `${key.slice(7)} · ${paid.length} address${paid.length === 1 ? "" : "es"} paid`));
    if (paid.length) {
      const table = el("table");
      const head = el("tr");
      for (const h of ["Address", "Times paid", "Last"]) head.append(el("th", h));
      table.append(head);
      for (const c of paid.slice(0, 200)) {
        const tr = el("tr");
        const addr = el("td", c.label ? `${c.label} (${short(c.address)})` : c.address, "addr");
        addr.title = c.address;
        tr.append(addr, el("td", String(c.timesPaid)), el("td", day(c.lastSeen)));
        table.append(tr);
      }
      const wrap = el("div", "", "scroll");
      wrap.append(table);
      d.append(wrap);
    }
    const forget = el("button", "Forget this wallet's history", "small");
    forget.addEventListener("click", async () => {
      if (!confirm("Forget every address this wallet has paid? Warden will treat them all as new, and can no longer spot look-alikes of them.")) return;
      await chrome.storage.local.remove(key);
      await load();
    });
    d.append(forget);
    memory.append(d);
  }
}

$("saveRpc").addEventListener("click", async () => {
  const mode = document.querySelector<HTMLInputElement>('input[name="rpc"]:checked')?.value ?? "public";
  const url = mode === "off" ? "" : mode === "public" ? DEFAULT_RPC : cleanRpcUrl($<HTMLInputElement>("rpcUrl").value);
  if (url === null || (mode === "own" && url === "")) return note("rpcNote", "That is not an address I can use. It has to start with https://", true);
  await chrome.storage.local.set({ rpcUrl: url });
  note("rpcNote", mode === "off" ? "Saved. Warden will make no network calls." : "Saved.");
  await load();
});
$("rpcUrl").addEventListener("input", () => { const own = document.querySelector<HTMLInputElement>('input[name="rpc"][value="own"]'); if (own) own.checked = true; });

$("simulate").addEventListener("change", async () => {
  const on = $<HTMLInputElement>("simulate").checked;
  await chrome.storage.local.set({ simulate: on });
  note("simNote", on ? "On. The RPC above will see each transaction Warden simulates." : "Off. No transaction leaves this browser.");
  await load();
});

$("decoyFirst").addEventListener("change", async () => {
  const on = $<HTMLInputElement>("decoyFirst").checked;
  await chrome.storage.local.set({ decoyFirst: on });
  // off, the record of which sites passed has no use: it is removed
  if (!on) await chrome.storage.local.remove("decoyPassed");
  note("decoyNote", on ? "On. A site you have not used is shown the decoy before your wallet." : "Off. Every site is connected to your wallet as always, and the record of which sites passed is removed.");
  await load();
});
$("saveDecoy").addEventListener("click", async () => {
  const typed = $<HTMLInputElement>("decoyAddress").value.trim();
  const address = cleanAddress(typed);
  if (typed !== "" && !address) return note("decoyNote", "That is not an address.", true);
  // the sites that passed were judged against the old decoy: they are shown the new one once
  await chrome.storage.local.set({ decoyAddress: address });
  await chrome.storage.local.remove("decoyPassed");
  note("decoyNote", address ? "Saved." : "Removed. There is no decoy to show.");
  await load();
});

$("reportSigned").addEventListener("change", async () => {
  const on = $<HTMLInputElement>("reportSigned").checked;
  await chrome.storage.local.set({ reportSigned: on });
  note("reportNote", on ? "On. Only wallets linked on the Sentinel page report, and only transactions you let through." : "Off. Warden sends Lamport nothing.");
  await load();
});

$("addSite").addEventListener("click", async () => {
  const origin = cleanOrigin($<HTMLInputElement>("site").value);
  if (!origin) return note("siteNote", "Type the site's address, like app.example.com", true);
  const s = settingsFrom(await chrome.storage.local.get([...KEYS]));
  if (!s.ringSites.includes(origin)) await chrome.storage.local.set({ ringSites: [...s.ringSites, origin] });
  $<HTMLInputElement>("site").value = "";
  note("siteNote", `${origin} may now ask. You will still be asked to confirm each time.`);
  await load();
});

void load();
