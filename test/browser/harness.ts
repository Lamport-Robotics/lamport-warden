/**
 * Runs the built extension in Chromium beside a wallet extension and a dapp page. Everything a person would
 * do is done with real input: the prompt lives in a closed shadow root, which page scripts cannot reach, so
 * its buttons are found through the debugger protocol and clicked with the mouse.
 */
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const WARDEN = join(here, "..", "..", "dist");
export const WALLETS = join(here, "dist", "wallet-ext");
const PAGE = join(here, "dist", "page");

export interface Site { server: Server; origin: string; rpcCalls: string[][]; setTable(key: string, base64: string | null): void }

/** The dapp page, and an RPC that knows whatever lookup tables a test gives it. */
export async function serve(): Promise<Site> {
  const tables = new Map<string, string>();
  const rpcCalls: string[][] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/rpc") {
      // an extension's worker is another origin: a public RPC answers it with these headers, and so does this one
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const keys: string[] = JSON.parse(body).params[0];
        rpcCalls.push(keys);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: keys.map((k) => (tables.has(k) ? { data: [tables.get(k), "base64"], owner: "AddressLookupTab1e1111111111111111111111111" } : null)) } }));
      });
      return;
    }
    const file = url.pathname === "/app.js" ? "app.js" : "index.html";
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(join(PAGE, file)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, origin: `http://localhost:${port}`, rpcCalls, setTable: (k, v) => { if (v === null) tables.delete(k); else tables.set(k, v); } };
}

export interface Browser { ctx: BrowserContext; extensionId: string; close(): Promise<void> }

/** Chromium with these unpacked extensions, in this order. CHROMIUM_PATH picks a browser Playwright did not install. */
export async function launch(extensions: string[]): Promise<Browser> {
  for (const e of extensions) if (!existsSync(join(e, "manifest.json"))) throw new Error(`not built: ${e} (run pnpm build && pnpm build:fixtures)`);
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "warden-browser-")), {
    executablePath,
    channel: executablePath ? undefined : "chromium",
    headless: false, // the flag below is the headless mode that loads extensions
    args: ["--headless=new", `--disable-extensions-except=${extensions.join(",")}`, `--load-extension=${extensions.join(",")}`, "--no-first-run", "--no-default-browser-check"],
    viewport: { width: 1000, height: 760 },
  });
  let worker = ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"));
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/background.js"), timeout: 15_000 });
  return { ctx, extensionId: new URL(worker.url()).host, close: () => ctx.close() };
}

interface Node { nodeId: number; backendNodeId: number; nodeName: string; nodeValue?: string; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] }

/** What a person sees of Warden's prompt, read through the debugger: page scripts cannot read it at all. */
export class Prompt {
  private constructor(private page: Page, private cdp: CDPSession) {}
  static async on(page: Page): Promise<Prompt> { return new Prompt(page, await page.context().newCDPSession(page)); }

  private async card(): Promise<Node | null> {
    const { root } = (await this.cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: Node };
    let found: Node | null = null;
    const walk = (n: Node, inShadow: boolean) => {
      if (inShadow && n.nodeName === "DIV" && attr(n, "class") === "card") found = n;
      for (const c of n.children ?? []) walk(c, inShadow);
      for (const s of n.shadowRoots ?? []) walk(s, true);
    };
    walk(root, false);
    return found;
  }

  /** Waits for the prompt and returns its text, or null when none came up in time. */
  async text(timeoutMs = 4000): Promise<{ tag: string; sentence: string; all: string; buttons: string[] } | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const card = await this.card();
      if (card) {
        const byClass = (cls: string) => texts(find(card, (n) => (attr(n, "class") ?? "").split(" ").includes(cls))[0]).join("");
        return { tag: byClass("tag"), sentence: byClass("sentence"), all: texts(card).join(" | "), buttons: find(card, (n) => n.nodeName === "BUTTON").map((b) => texts(b).join("")) };
      }
      if (Date.now() > until) return null;
      await this.page.waitForTimeout(100);
    }
  }

  async shown(): Promise<boolean> { return (await this.card()) !== null; }

  /** Clicks a button of the prompt with the mouse. */
  async click(label: string): Promise<void> {
    const card = await this.card();
    const button = card && find(card, (n) => n.nodeName === "BUTTON" && texts(n).join("") === label)[0];
    if (!button) throw new Error(`the prompt has no "${label}" button`);
    const { model } = (await this.cdp.send("DOM.getBoxModel", { backendNodeId: button.backendNodeId })) as { model: { content: number[] } };
    const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
    await this.page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  }

  /** Types into the prompt's confirmation field with the keyboard. */
  async type(text: string): Promise<void> {
    const card = await this.card();
    const input = card && find(card, (n) => n.nodeName === "INPUT")[0];
    if (!input) throw new Error("the prompt has no field to type in");
    const { model } = (await this.cdp.send("DOM.getBoxModel", { backendNodeId: input.backendNodeId })) as { model: { content: number[] } };
    const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
    await this.page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
    await this.page.keyboard.type(text);
  }

  /** Whether the Continue button is there and can be pressed. */
  async canContinue(): Promise<boolean> {
    const card = await this.card();
    const go = card && find(card, (n) => n.nodeName === "BUTTON" && texts(n).join("") === "Continue to wallet")[0];
    return !!go && attr(go, "disabled") === undefined;
  }
}

const attr = (n: Node, name: string): string | undefined => { const a = n.attributes ?? []; for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1]; return undefined; };
const find = (n: Node, test: (n: Node) => boolean): Node[] => [...(test(n) ? [n] : []), ...(n.children ?? []).flatMap((c) => find(c, test))];
const texts = (n: Node | undefined): string[] => (!n ? [] : n.nodeName === "#text" ? [n.nodeValue ?? ""] : (n.children ?? []).flatMap(texts));

/** What the stand-in wallets were asked, and how each signing call the page started has ended. */
export const calls = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__calls.slice());
export const result = (page: Page, tag: string): Promise<string> => page.evaluate((t) => (window as any).__results[t], tag);
export async function settled(page: Page, tag: string, timeoutMs = 5000): Promise<string> {
  await page.waitForFunction((t) => (window as any).__results[t] !== "pending", tag, { timeout: timeoutMs });
  return result(page, tag);
}
