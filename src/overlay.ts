/**
 * The prompt. Drawn by the isolated-world script inside a closed shadow root, so the page's scripts cannot
 * read it, restyle it or reach its buttons, and a click only counts when the browser says a person made it.
 */
import type { WireVerdict } from "./messages.js";

const CSS = `
:host { all: initial; }
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

    const finish = (ok: boolean) => { host.remove(); resolve(ok); };
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
      go.addEventListener("click", (e) => { if (e.isTrusted && !go.disabled) finish(true); });
      row.append(go);
    }
    card.append(row);
    veil.append(card);
    root.append(style, veil);
    (document.documentElement ?? document).append(host);
  });
}
