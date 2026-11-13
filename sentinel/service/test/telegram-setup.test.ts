/**
 * The script that gives the deployed service its Telegram bot (sentinel/telegram-setup.sh), run for real with
 * stand-ins for the two commands it reaches out with. `curl` answers as Telegram would; `ssh` runs what it
 * was given here, against a settings file in a temporary folder, with a stand-in for systemctl.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SECRET = "AAH" + "k".repeat(32);
const TOKEN = `7123456789:${SECRET}`;

function setup(opts: { known?: boolean; env?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-telegram-setup-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const acts = join(dir, "acts.log"), envFile = join(dir, "sentinel.env");
  writeFileSync(envFile, opts.env ?? "SENTINEL_RPC_URL=https://rpc.example\nSENTINEL_DATA_KEY=abc=\n", { mode: 0o600 });
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const log = (name: string) => `printf '${name}' >> "${acts}"; for a in "$@"; do printf ' [%s]' "$a" >> "${acts}"; done; printf '\\n' >> "${acts}"`;
  // curl: what it was given on its input is kept, and it answers as Telegram does
  script("curl", `${log("curl")}\ncat > "${dir}/curl-input"\nprintf '%s' '${opts.known === false ? '{"ok":false,"error_code":401,"description":"Unauthorized"}' : '{"ok":true,"result":{"id":7123456789,"is_bot":true,"first_name":"Warden Sentinel","username":"WardenSentinelBot"}}'}'`);
  // ssh: runs the last argument here, with its own input, as the server's shell would
  script("ssh", `${log("ssh")}\nfor a in "$@"; do last="$a"; done\nexec sh -c "$last"`);
  script("systemctl", `${log("systemctl")}\nexit 0`);
  const run = (input: string): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const child = spawn("sh", [join(root, "sentinel", "telegram-setup.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, SENTINEL_REMOTE_ENV: envFile } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
  const did = () => (existsSync(acts) ? readFileSync(acts, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, envFile, run, did };
}

describe("giving the deployed service its Telegram bot", () => {
  it("checks the token with Telegram, writes it where only root reads, and restarts the service", async () => {
    const s = setup();
    const r = await s.run(`${TOKEN}\n`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Telegram alerts are on. The bot is @WardenSentinelBot");
    const env = readFileSync(s.envFile, "utf8");
    expect(env).toBe(`SENTINEL_RPC_URL=https://rpc.example\nSENTINEL_DATA_KEY=abc=\nSENTINEL_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    expect(statSync(s.envFile).mode & 0o777).toBe(0o600);
    // the file as it was is beside it
    const backups = readdirSync(s.dir).filter((f) => f.startsWith("sentinel.env.bak-telegram-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(s.dir, backups[0]!), "utf8")).not.toContain("TELEGRAM");
    // (what ssh was given is several lines long in the record; the stand-in's own lines have their arguments in brackets)
    expect(s.did().filter((a) => a.startsWith("systemctl ["))[0]).toBe("systemctl [restart] [lamport-sentinel.service]");
    // the token was on no command line, and in nothing the script said
    for (const act of s.did()) expect(act).not.toContain(SECRET);
    expect(r.out).not.toContain(SECRET);
    expect(readFileSync(join(s.dir, "curl-input"), "utf8")).toBe(`url = "https://api.telegram.org/bot${TOKEN}/getMe"\n`);
  }, 30_000);

  it("replaces a token that was there, and leaves the other settings as they were", async () => {
    const s = setup({ env: "SENTINEL_RPC_URL=https://rpc.example\nSENTINEL_TELEGRAM_BOT_TOKEN=1111111111:" + "o".repeat(35) + "\nSENTINEL_PORT=8791\n" });
    expect((await s.run(`${TOKEN}\n`)).code).toBe(0);
    expect(readFileSync(s.envFile, "utf8")).toBe(`SENTINEL_RPC_URL=https://rpc.example\nSENTINEL_PORT=8791\nSENTINEL_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  }, 30_000);

  it("changes nothing for something that is not a token, and asks nobody about it", async () => {
    for (const bad of ["", "hello", "123:short", `${TOKEN} extra`, `bot${TOKEN}`, `${TOKEN}; rm -rf /`]) {
      const s = setup();
      const before = readFileSync(s.envFile, "utf8");
      const r = await s.run(`${bad}\n`);
      expect(r.code, bad).toBe(1);
      expect(r.out).toContain("That is not a bot token as BotFather gives them");
      expect(s.did(), bad).toEqual([]);
      expect(readFileSync(s.envFile, "utf8")).toBe(before);
    }
  }, 60_000);

  it("changes nothing when Telegram does not know the token", async () => {
    const s = setup({ known: false });
    const before = readFileSync(s.envFile, "utf8");
    const r = await s.run(`${TOKEN}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Telegram does not know that token (or could not be reached). Nothing was changed.");
    expect(s.did().map((a) => a.split(" ")[0])).toEqual(["curl"]); // and the server is not touched
    expect(readFileSync(s.envFile, "utf8")).toBe(before);
  }, 30_000);
});
