/**
 * The prompt. Drawn by the isolated-world script inside a closed shadow root, so the page's scripts cannot
 * read it or reach its buttons, and a click only counts when the browser says a person made it.
 *
 * The page still owns everything around it: it can paint a layer on top with a bait that lets clicks fall
 * through, or make the prompt's element transparent. So "Continue" also needs the browser's own word that the
 * button has been on screen, unobscured and unaltered, for a moment before the click (IntersectionObserver
 * with trackVisibility, which exists for exactly this). A prompt the page hides can only be cancelled, and a
 * prompt the page removes is a refusal.
 */
import type { WireVerdict } from "./messages.js";

const CSS = `
:host { all: initial; direction: ltr; unicode-bidi: isolate; }
.veil { position: fixed; inset: 0; z-index: 2147483647; background: rgba(8, 8, 7, 0.62); display: flex; align-items: center; justify-content: center; font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.card { width: min(440px, calc(100vw - 32px)); background: #f2eee3; color: #14130f; border-radius: 14px; padding: 20px 20px 16px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45); }
.tag { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; margin-bottom: 10px; }
.tag.block { color: #a1260d; } .tag.confirm { color: #8a5a00; } .tag.explain { color: #4a4a40; }
.sentence { font-size: 16px; margin: 0 0 10px; overflow-wrap: anywhere; white-space: pre-wrap; }
.site { font-size: 12px; color: #5c5a50; margin: 0 0 14px; overflow-wrap: anywhere; }
ul { margin: 0 0 14px; padding-left: 18px; color: #3b3a33; font-size: 13px; }
label { display: block; font-size: 13px; margin-bottom: 6px; }
input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 10px; border: 1px solid #b9b4a4; border-radius: 8px; background: #fffdf6; color: inherit; margin-bottom: 14px; }
.row { display: flex; gap: 10px; justify-content: flex-end; }
button { font: inherit; font-weight: 600; border-radius: 999px; padding: 9px 18px; border: 1px solid #14130f; background: transparent; color: #14130f; cursor: pointer; }
button.go { background: #14130f; color: #f2eee3; }
button:disabled { opacity: 0.35; cursor: default; }
`;

const LABEL = { block: "Blocked", confirm: "Check this carefully", explain: "Before you sign", allow: "" } as const;

/** Resolves true when the owner lets the request go on to the wallet. A blocked request only resolves false. */
export function prompt(verdict: WireVerdict, origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const veil = document.createElement("div");
    veil.className = "veil";
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");

    const el = (tag: string, cls: string, text: string) => { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; };
    card.append(el("div", `tag ${verdict.level}`, `Lamport Warden · ${LABEL[verdict.level]}`));
    card.append(el("p", "sentence", verdict.sentence));
    card.append(el("p", "site", `Asked by ${origin}`));
    if (verdict.reasons.length > 1) {
      const ul = document.createElement("ul");
      for (const r of verdict.reasons.slice(0, 4)) ul.append(el("li", "", r.charAt(0).toUpperCase() + r.slice(1)));
      card.append(ul);
    }

    const parent: ParentNode = document.documentElement ?? document;
    /** Whether this browser has a top layer to put the prompt in: where it has, a press counts only while the prompt is in it. */
    const topLayer = typeof (host as { showPopover?: unknown }).showPopover === "function";
    let done = false;
    let watching: { disconnect(): void }[] = [];
    /** When the page last changed how the prompt's own element is laid out. */
    let stirred = -Infinity;
    let raising: ReturnType<typeof setInterval> | undefined;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      for (const w of watching) w.disconnect();
      if (raising !== undefined) clearInterval(raising);
      host.remove();
      resolve(ok);
    };
    const row = el("div", "row", "");
    const cancel = el("button", "", verdict.level === "block" ? "Close" : "Cancel") as HTMLButtonElement;
    cancel.addEventListener("click", (e) => { if (e.isTrusted) finish(false); });
    row.append(cancel);

    if (verdict.level !== "block") {
      const go = el("button", "go", "Continue to wallet") as HTMLButtonElement;
      if (verdict.level === "confirm" && verdict.confirm) {
        const want = verdict.confirm.expect;
        const lab = el("label", "", verdict.confirm.kind === "last4" ? "Type the last 4 characters of the address to continue" : `Type "${want}" to continue`);
        const input = document.createElement("input");
        input.autocomplete = "off";
        input.spellcheck = false;
        go.disabled = true;
        // typed by a person, not set by a script: only trusted input events count
        let typed = false;
        input.addEventListener("input", (e) => { typed = e.isTrusted; go.disabled = !(typed && input.value.trim() === want); });
        card.append(lab, input);
        queueMicrotask(() => input.focus());
      }
      // Seen by a person: the browser reports when the button, and the card whose words it answers, are fully
      // on screen with nothing painted over them and no effect (opacity, transform, filter) altering them.
      // Where the browser cannot say, a trusted click is all there is to go on.
      const tracked = typeof IntersectionObserver === "function" && typeof IntersectionObserverEntry === "function" && "isVisible" in IntersectionObserverEntry.prototype;
      const seenSince = new Map<Element, number | null>([[go, null], [card, null]]);
      if (tracked) {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries as (IntersectionObserverEntry & { isVisible?: boolean })[]) {
            seenSince.set(entry.target, entry.isIntersecting && entry.isVisible ? (seenSince.get(entry.target) ?? performance.now()) : null);
          }
        }, { threshold: 1, trackVisibility: true, delay: 100 } as IntersectionObserverInit);
        io.observe(go);
        io.observe(card);
        watching.push(io);
      }
      // Standing still: a plain move does not hide a button from the check above (the page can turn its whole
      // document right-to-left, shift it, or put the prompt's element somewhere else), so where the button is
      // gets looked at too, and it counts only once it has been in one place for a moment.
      // (where there is no layout to ask, as under test outside a browser, there is nothing to look at)
      const placed = typeof go.getBoundingClientRect === "function";
      const place = () => { const r = go.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; };
      let at = "", atSince = performance.now();
      const look = () => { if (!placed) return; const now = place(); if (now !== at) { at = now; atSince = performance.now(); } };
      if (placed) {
        const looking = setInterval(look, 100);
        (looking as { unref?: () => void }).unref?.();
        watching.push({ disconnect: () => clearInterval(looking) });
      }
      const SEEN_FOR_MS = 400;
      go.addEventListener("click", (e) => {
        if (!e.isTrusted || go.disabled) return;
        const now = performance.now();
        for (const since of seenSince.values()) if (tracked && (since === null || now - since < SEEN_FOR_MS)) return; // covered, altered, or only just shown
        if (now - stirred < SEEN_FOR_MS) return; // its element was changed a moment ago
        look();
        if (placed && now - atSince < SEEN_FOR_MS) return; // moved a moment ago: a button slid under a pointer is not a button somebody chose to press
        if (host.parentNode != null && host.parentNode !== parent) return; // put somewhere else in the page
        if (topLayer && !host.matches(":popover-open")) return; // taken out of the browser's top layer, where the page can paint over it
        finish(true);
      });
      row.append(go);
    }
    card.append(row);
    veil.append(card);
    root.append(style, veil);
    parent.append(host);
    // In the browser's top layer, above every z-index the page can set, and put back on top of anything the page
    // raises after it. This is for the owner's sake, so the prompt can be read; the visibility check above is what
    // refuses a click when the page wins that race.
    const raise = () => { try { if (host.matches(":popover-open")) host.hidePopover(); host.showPopover(); } catch { /* no top layer here: the prompt stays where it is */ } };
    try {
      host.setAttribute("popover", "manual");
      // the browser's own popover styling gives it a size, a border and a background: `all` takes those away.
      // (No colour is named here: tools that recolour pages rewrite inline styles that name one, and would
      // then be at it for as long as this puts its own back.)
      const laidOut = "all:initial !important;position:fixed !important;inset:0 !important;width:auto !important;height:auto !important;max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;overflow:visible !important;direction:ltr !important;unicode-bidi:isolate !important;";
      host.style.cssText = laidOut;
      const asSet = host.style.cssText; // as the browser writes it back
      // The element is the page's to reach, though not what is in it. A page can rewrite its style to move the
      // whole prompt, hide it, or make it inert. What the page changes is put back, and the button counts
      // again only a moment after. Marks other tools leave on every element (data-*, aria-*) are left alone.
      if (typeof MutationObserver === "function") {
        const still = new MutationObserver(() => {
          let changed = false;
          for (const a of Array.from(host.attributes)) if (a.name !== "popover" && a.name !== "style" && !a.name.startsWith("data-") && !a.name.startsWith("aria-")) { host.removeAttribute(a.name); changed = true; }
          if (host.getAttribute("popover") !== "manual") { host.setAttribute("popover", "manual"); changed = true; }
          if (host.style.cssText !== asSet) { host.style.cssText = laidOut; changed = true; }
          if (changed) stirred = performance.now();
          still.takeRecords(); // what was just put back is not the page's doing
        });
        still.observe(host, { attributes: true });
        watching.push(still);
      }
      raise();
      raising = setInterval(() => { if (!done) raise(); }, 250);
      (raising as { unref?: () => void }).unref?.();
    } catch { /* an older browser: an ordinary fixed layer */ }
    // taken out of the page by the page: nobody can answer it any more, so it is a refusal
    if (typeof MutationObserver === "function") {
      // (moved somewhere else in the page counts as taken out: where it is put, the page decides what is seen of it)
      const mo = new MutationObserver(() => { if (!done && (!host.isConnected || host.parentNode !== parent)) finish(false); });
      mo.observe(parent, { childList: true, subtree: true });
      watching.push(mo);
    }
  });
}

const NOTICE_CSS = `
:host { all: initial; }
.note { box-sizing: border-box; width: min(340px, calc(100vw - 24px)); background: #f2eee3; color: #14130f; border-radius: 12px; padding: 12px 14px 12px; box-shadow: 0 10px 36px rgba(0, 0, 0, 0.4); font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.tag { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; color: #4a4a40; margin-bottom: 6px; }
.tag.warn { color: #a1260d; }
p { margin: 0 0 10px; overflow-wrap: anywhere; }
button { font: inherit; font-weight: 600; border-radius: 999px; padding: 6px 14px; border: 1px solid #14130f; background: transparent; color: #14130f; cursor: pointer; }
`;

/**
 * A small card in a corner of the page that stays until it is taken down. It says a decoy is showing, and
 * its one button ends that. It does not cover the page and asks nothing. Drawn like the prompt: in a closed
 * shadow root, and its button counts only when a person presses it where it can be seen.
 */
export function notice(o: { text: string; button: string; warn?: boolean; onPress(): void }): { remove(): void } {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = NOTICE_CSS;
  const card = document.createElement("div");
  card.className = "note";
  card.setAttribute("role", "status");
  const el = (tag: string, cls: string, text: string) => { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; };
  const button = el("button", "", o.button) as HTMLButtonElement;
  card.append(el("div", o.warn ? "tag warn" : "tag", "Lamport Warden · A decoy first"), el("p", "", o.text), button);
  const tracked = typeof IntersectionObserver === "function" && typeof IntersectionObserverEntry === "function" && "isVisible" in IntersectionObserverEntry.prototype;
  let seenSince: number | null = null;
  let io: IntersectionObserver | null = null;
  if (tracked) {
    io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
      seenSince = last.isIntersecting && last.isVisible ? (seenSince ?? performance.now()) : null;
    }, { threshold: 1, trackVisibility: true, delay: 100 } as IntersectionObserverInit);
    io.observe(button);
  }
  /** When the page last moved the notice, or took it out. */
  let stirred = -Infinity;
  button.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    if (tracked && (seenSince === null || performance.now() - seenSince < 400)) return; // covered, altered, or only just shown
    if (performance.now() - stirred < 400) return; // moved a moment ago: a button slid under a pointer is not a button somebody chose to press
    o.onPress();
  });
  root.append(style, card);
  const parent = document.documentElement ?? document;
  parent.append(host);
  const laidOut = "all:initial !important;position:fixed !important;top:12px !important;right:12px !important;left:auto !important;bottom:auto !important;width:auto !important;height:auto !important;margin:0 !important;padding:0 !important;border:0 !important;background:transparent !important;overflow:visible !important;";
  let raising: ReturnType<typeof setInterval> | undefined;
  let asSet = "";
  let taken = false;
  const watching: { disconnect(): void }[] = [];
  try {
    host.setAttribute("popover", "manual");
    host.style.cssText = laidOut;
    asSet = host.style.cssText;
    const raise = () => { try { if (!host.matches(":popover-open")) host.showPopover(); } catch { /* no top layer here: it stays where it is */ } };
    raise();
    raising = setInterval(raise, 1000);
    (raising as { unref?: () => void }).unref?.();
  } catch {
    host.style.cssText = "all:initial !important;position:fixed !important;top:12px !important;right:12px !important;z-index:2147483647 !important;";
    asSet = host.style.cssText;
  }
  // The element is the page's to reach, though not what is in it. A page that moves it has its changes put
  // back, and one that takes it out has it put in again: it is the owner's way of ending the decoy, and is
  // not the page's to take away. (A page can tell from it that a decoy is showing. It can tell that anyway.)
  if (typeof MutationObserver === "function") {
    const still = new MutationObserver(() => {
      stirred = performance.now();
      for (const a of Array.from(host.attributes)) if (a.name !== "popover" && a.name !== "style") host.removeAttribute(a.name);
      if (host.style.cssText !== asSet) { host.style.cssText = laidOut; asSet = host.style.cssText; }
      still.takeRecords();
    });
    still.observe(host, { attributes: true });
    let putBack = 0;
    const there = new MutationObserver(() => {
      if (taken || host.isConnected) return;
      stirred = performance.now();
      // (not in a loop with a page that keeps taking it out: a few times a second is enough to be seen)
      if (performance.now() - putBack < 250) { setTimeout(() => { if (!taken && !host.isConnected) { putBack = performance.now(); parent.append(host); } }, 250); return; }
      putBack = performance.now();
      parent.append(host);
    });
    there.observe(parent, { childList: true });
    watching.push(still, there);
  }
  return { remove() { taken = true; io?.disconnect(); for (const w of watching) w.disconnect(); if (raising !== undefined) clearInterval(raising); host.remove(); } };
}

