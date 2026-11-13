/** The settings page. Everything is built with textContent: stored addresses and labels are never parsed as HTML. */
import { DEFAULT_RPC } from "./defaults.js";
import { cleanOrigin, cleanRpcUrl, settingsFrom } from "./settings.js";
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

  // lookup tables
  const mode = s.rpcUrl === "" ? "off" : s.rpcUrl === DEFAULT_RPC ? "public" : "own";
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="rpc"]')) r.checked = r.value === mode;
  $<HTMLInputElement>("rpcUrl").value = mode === "own" ? s.rpcUrl : "";

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

$("addSite").addEventListener("click", async () => {
  const origin = cleanOrigin($<HTMLInputElement>("site").value);
  if (!origin) return note("siteNote", "Type the site's address, like app.example.com", true);
  const s = settingsFrom(await chrome.storage.local.get(["rpcUrl", "ringSites"]));
  if (!s.ringSites.includes(origin)) await chrome.storage.local.set({ ringSites: [...s.ringSites, origin] });
  $<HTMLInputElement>("site").value = "";
  note("siteNote", `${origin} may now ask. You will still be asked to confirm each time.`);
  await load();
});

void load();
