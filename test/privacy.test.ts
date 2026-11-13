/**
 * The privacy policy says what Sentinel, the service, keeps and for how long. It is written twice (PRIVACY.md
 * and the page at /privacy/), and it states numbers that live in the code. This fails when the two texts part
 * ways, or when the code stops doing what the policy says.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_SECONDS } from "../sentinel/service/src/accounts.js";
import { SNAPSHOT_DAYS } from "../sentinel/service/src/store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const md = read("PRIVACY.md");
const html = read("site", "privacy", "index.html");
const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));
const mdSentinel = flat(section(md, "## Sentinel, the service", "## Changes and contact").replace(/`/g, "").replace(/^- /gm, ""));
const htmlSentinel = section(html, "<h2>Sentinel, the service</h2>", "<h2>Changes and contact</h2>");

describe("the privacy policy, about the service", () => {
  it("says the same in the file and on the page", () => {
    // the page gives each list item a short bold lead-in; everything after it is the file's own sentence
    const sentences = htmlSentinel
      .replace(/<b>[^<]*\.<\/b>\s*/g, "")
      .replace(/<[^>]+>/g, "\n")
      .split(/\n|(?<=[.:])\s+(?=[A-Z"])/)
      .map((s) => flat(s))
      .filter((s) => s.split(" ").length >= 6);
    expect(sentences.length).toBeGreaterThan(20);
    for (const s of sentences) expect(mdSentinel, s).toContain(s);
    // and nothing in the file is missing from the page: the same number of words, near enough
    const words = (s: string) => s.split(" ").length;
    const pageWords = words(flat(htmlSentinel.replace(/<b>[^<]*\.<\/b>\s*/g, "").replace(/<[^>]+>/g, " ")));
    expect(Math.abs(pageWords - words(mdSentinel))).toBeLessThan(40);
  });

  it("states the times the code keeps to", () => {
    expect(SESSION_SECONDS).toBe(7 * 86_400);
    expect(mdSentinel).toContain("each session as a hash, for seven days");
    expect(SNAPSHOT_DAYS).toBe(7);
    expect(mdSentinel).toContain("daily backups hold them for up to seven days more");
    // reported signatures: thirty days, in the watcher and in the store
    expect(read("sentinel", "service", "src", "watcher.ts")).toContain("now - at <= 30 * 86_400");
    expect(mdSentinel).toContain("the signatures your browser reported, for 30 days");
    // the longest the limiter remembers where a request came from is a day
    const windows = [...read("sentinel", "service", "src", "server.ts").matchAll(/limiter\.allow\(`(?:nonce|signin|create):\$\{from\}`, [^,]+, ([\d_]+), t\)/g)].map((m) => Number(m[1]!.replace(/_/g, "")));
    expect(windows.length).toBe(3);
    expect(Math.max(...windows)).toBe(86_400);
    expect(mdSentinel).toContain("held in memory for up to a day");
  });

  it("is right about cookies, analytics and what the practice page sends", () => {
    const page = read("sentinel", "web", "src", "app.ts");
    expect(page).not.toMatch(/document\.cookie|localStorage/);
    expect(page).toContain("sessionStorage");
    expect(read("sentinel", "service", "src", "server.ts")).not.toMatch(/set-cookie/i);
    for (const file of [read("sentinel", "web", "index.html"), read("site", "try", "index.html")]) {
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(file)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'"); // no analytics script could load
    }
    // the practice page may talk to nothing at all
    expect(/Content-Security-Policy" content="([^"]+)"/.exec(read("site", "try", "index.html"))![1]!).not.toContain("connect-src");
    // the RPC it names is the one the deployment is given
    expect(read("sentinel", "deploy.sh")).toContain("SENTINEL_RPC_URL=https://api.mainnet-beta.solana.com");
    expect(mdSentinel).toContain("api.mainnet-beta.solana.com");
    // what the channel is sent: the wallet by its first and last four characters
    expect(read("sentinel", "service", "src", "notify.ts")).toContain("`${a.slice(0, 4)}..${a.slice(-4)}`");
  });
});
