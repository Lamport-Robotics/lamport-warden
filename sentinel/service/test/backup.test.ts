/**
 * The copy of Sentinel's data kept off its server (sentinel/backup.sh), the look at the service from the
 * machine that keeps it (sentinel/watch-from-here.sh), and the jobs that run both on a Mac
 * (sentinel/mac-agents.sh). The scripts themselves are run, with stand-ins for the commands they reach out
 * with (ssh, the keychain, the notification, curl, launchctl), which only write down what they were asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATA = JSON.stringify({ wallets: [{ address: "W1" }], records: {}, events: [], accounts: { profiles: {}, owners: {}, channels: [], sessions: [] } });
const KEY = Buffer.alloc(32, 5).toString("base64");
const OPS = "https://ntfy.sh/operator-topic-123";
const now = () => Math.floor(Date.now() / 1000);

function setup(opts: { data?: string | null; key?: string; ops?: string; sshFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-backup-"));
  const bin = join(dir, "bin"), dest = join(dir, "backups"), home = join(dir, "home");
  mkdirSync(bin); mkdirSync(home);
  const acts = join(dir, "acts.log");
  const fixture = join(dir, "remote-sentinel.json");
  if (opts.data !== null) writeFileSync(fixture, opts.data ?? DATA);
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // ssh: the last argument is what would run on the server
  script("ssh", `for a in "$@"; do last="$a"; done
printf 'ssh %s\\n' "$last" >> "${acts}"
${opts.sshFails ? "exit 255" : ""}
case "$last" in
  gzip*) ${opts.data === null ? "printf 'no such file'" : `gzip -c "${fixture}"`} ;;
  *SENTINEL_DATA_KEY*) printf '%s\\n' "${opts.key ?? KEY}" ;;
  *SENTINEL_OPS_CHANNEL*) printf '%s\\n' "${opts.ops ?? OPS}" ;;
esac`);
  // the keychain: one file an entry, and what was asked without what was stored
  script("security", `verb="$1"; shift
while [ $# -gt 0 ]; do case "$1" in -s) s="$2"; shift ;; -a) a="$2"; shift ;; -w) w="\${2-}"; [ $# -gt 1 ] && shift ;; -l) shift ;; esac; shift; done
case "$verb" in
  find-generic-password) cat "${dir}/kc-$s-$a" 2>/dev/null || exit 44 ;;
  add-generic-password) printf 'security add %s %s\\n' "$s" "$a" >> "${acts}"; printf '%s' "$w" > "${dir}/kc-$s-$a" ;;
esac`);
  for (const name of ["osascript", "curl", "launchctl"]) script(name, `printf '%s' "${name}" >> "${acts}"\nfor a in "$@"; do printf ' [%s]' "$a" >> "${acts}"; done\nprintf '\\n' >> "${acts}"\nexit 0`);
  script("uname", "echo Darwin");
  const run = (file: string, args: string[] = [], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const child = spawn("sh", [join(root, "sentinel", file), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, SENTINEL_BACKUP_DIR: dest, ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
  const did = () => (existsSync(acts) ? readFileSync(acts, "utf8").trim().split("\n").filter(Boolean) : []);
  const copies = () => (existsSync(dest) ? readdirSync(dest).filter((f) => /^sentinel-.*\.json\.gz$/.test(f)).sort() : []);
  const keychain = (name: string, host = "can") => { try { return readFileSync(join(dir, `kc-${name}-${host}`), "utf8"); } catch { return null; } };
  return { dir, dest, home, run, did, copies, keychain };
}

describe("the copy kept off the server", () => {
  it("is the data file as it is, where only its owner can read it, with the key in the keychain and not in a file", async () => {
    const s = setup();
    const r = await s.run("backup.sh");
    expect(r.code).toBe(0);
    expect(s.copies()).toHaveLength(1);
    const copy = join(s.dest, s.copies()[0]!);
    expect(s.copies()[0]).toMatch(/^sentinel-\d{8}T\d{6}Z\.json\.gz$/);
    expect(gunzipSync(readFileSync(copy)).toString()).toBe(DATA);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(s.dest).mode & 0o777).toBe(0o700);
    expect(r.out).toMatch(/^backup: kept sentinel-\S+ \(\d+ bytes\); 1 copies in /);
    expect(s.keychain("lamport-sentinel-data-key")).toBe(KEY);
    expect(s.keychain("lamport-sentinel-ops-channel")).toBe(OPS);
    // neither is in anything it wrote to disk or said
    for (const f of readdirSync(s.dest, { withFileTypes: true })) if (f.isFile() && !f.name.endsWith(".gz")) expect(readFileSync(join(s.dest, f.name), "utf8")).not.toContain(KEY);
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain(OPS);
    // what it asked the server for: the file, and those two settings. Not Stripe's keys.
    const asked = s.did().filter((a) => a.startsWith("ssh "));
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe("ssh gzip -c '/var/lib/private/lamport-sentinel/sentinel.json'");
    expect(asked.join("\n")).not.toMatch(/STRIPE|WEBHOOK/);
    expect(asked.slice(1).map((a) => /\^(SENTINEL_[A-Z_]+)=/.exec(a)![1])).toEqual(["SENTINEL_DATA_KEY", "SENTINEL_OPS_CHANNEL"]);
  }, 20_000);

  it("writes the keychain only when what it holds is not what the server has", async () => {
    const s = setup();
    await s.run("backup.sh");
    expect(s.did().filter((a) => a.startsWith("security add"))).toEqual(["security add lamport-sentinel-data-key can", "security add lamport-sentinel-ops-channel can"]);
    await s.run("backup.sh");
    expect(s.did().filter((a) => a.startsWith("security add"))).toHaveLength(2);
    // under the name of the host it was asked to copy from
    const other = setup();
    await other.run("backup.sh", ["elsewhere"]);
    expect(other.keychain("lamport-sentinel-data-key", "elsewhere")).toBe(KEY);
    expect(other.keychain("lamport-sentinel-data-key")).toBeNull();
  }, 30_000);

  it("keeps nothing that is not the data file, and says so", async () => {
    const garbage = setup({ data: null });
    const r = await garbage.run("backup.sh");
    expect(r.code).toBe(1);
    expect(r.out).toContain("backup: what came back from can is not Sentinel's data file; nothing was kept");
    expect(readdirSync(garbage.dest)).toEqual([]);
    expect(garbage.keychain("lamport-sentinel-data-key")).toBeNull();
    // a file that unpacks and is something else
    const wrong = setup({ data: '{"hello":"world"}' });
    expect((await wrong.run("backup.sh")).code).toBe(1);
    expect(readdirSync(wrong.dest)).toEqual([]);
    // and a server that cannot be reached
    const away = setup({ sshFails: true });
    expect((await away.run("backup.sh")).code).not.toBe(0);
    expect(readdirSync(away.dest)).toEqual([]);
  }, 30_000);

  it("removes copies older than seven days, which is as long as the privacy policy says they are kept", async () => {
    const s = setup();
    mkdirSync(s.dest, { recursive: true });
    const aged = (name: string, days: number) => { const f = join(s.dest, name); writeFileSync(f, "x"); const t = now() - days * 86_400 - 60; utimesSync(f, t, t); };
    aged("sentinel-20260101T000000Z.json.gz", 8);
    aged("sentinel-20260102T000000Z.json.gz", 7);
    aged("sentinel-20260103T000000Z.json.gz", 6);
    aged("notes.txt", 30); // not one of its own: left alone
    await s.run("backup.sh");
    expect(s.copies()).toHaveLength(2);
    expect(s.copies()).toContain("sentinel-20260103T000000Z.json.gz");
    expect(existsSync(join(s.dest, "notes.txt"))).toBe(true);
    expect(readFileSync(join(root, "PRIVACY.md"), "utf8").replace(/\s+/g, " ")).toContain("hold them for up to seven days more");
  }, 20_000);
});

describe("the look from the machine that keeps the copies", () => {
  let server: Server, url = "";
  let answer: Record<string, unknown> | "nothing" = {};
  beforeAll(async () => {
    server = createServer((_req, res) => { if (answer === "nothing") { res.destroy(); return; } res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/health`;
  });
  afterAll(() => { server?.close(); });
  const healthy = () => ({ ok: true, watching: 4, lastPassAt: now() - 5, blind: 0, late: 0, push: "on" });
  const watch = (s: ReturnType<typeof setup>) => s.run("watch-from-here.sh", [], { SENTINEL_HEALTH_URL: url, SENTINEL_CHECK: join(root, "scripts", "check-live.mjs"), SENTINEL_CHECK_ARGS: "--once", SENTINEL_WATCH_AGAIN_AFTER: "0" });

  it("says nothing while the service watches and a copy was made lately", async () => {
    const s = setup();
    await s.run("backup.sh");
    const before = s.did().length;
    answer = healthy();
    expect(await watch(s)).toEqual({ code: 0, out: "" });
    expect(s.did().slice(before)).toEqual([]);
  }, 30_000);

  it("says so here and on the operator's channel when the service does not answer, once an hour", async () => {
    const s = setup();
    await s.run("backup.sh");
    const before = s.did().length;
    answer = "nothing";
    const r = await watch(s);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^watch: Seen from outside its server: Sentinel is not watching: the service did not answer in one try/);
    const acts = s.did().slice(before);
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatch(/^osascript .*\[display notification \(item 1 of argv\) with title "Warden Sentinel"\].*\[Seen from outside its server: Sentinel is not watching: the service did not answer in one try/);
    expect(acts[1]).toMatch(/^curl \[-fsS\] \[-m\] \[10\] \[-H\] \[Title: Warden Sentinel: operations\] \[-d\] \[Seen from outside its server: .*\] \[https:\/\/ntfy\.sh\/operator-topic-123\]$/);
    // ten minutes later it is still down: not said again
    expect((await watch(s)).out).toBe("");
    expect(s.did().slice(before)).toHaveLength(2);
  }, 30_000);

  it("posts only where a plain line is taken", async () => {
    const s = setup({ ops: ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/") });
    await s.run("backup.sh");
    const before = s.did().length;
    answer = "nothing";
    await watch(s);
    expect(s.did().slice(before).map((a) => a.split(" ")[0])).toEqual(["osascript"]);
  }, 30_000);

  it("says so when no copy has been made for two days", async () => {
    const s = setup();
    answer = healthy();
    const none = await watch(s);
    expect(none.out).toBe("watch: No copy of Sentinel's data has been made here for 2 days. The copies on the server are on the same disk as the data.\n");
    expect(s.did().filter((a) => a.startsWith("osascript"))).toHaveLength(1);
    // an old copy is not a copy made lately
    const old = setup();
    await old.run("backup.sh");
    const copy = join(old.dest, old.copies()[0]!);
    const t = now() - 3 * 86_400;
    utimesSync(copy, t, t);
    expect((await watch(old)).out).toContain("No copy of Sentinel's data has been made here for 2 days.");
  }, 30_000);
});

describe("the jobs on a Mac", () => {
  it("are two launchd agents for this user, run from copies of the scripts, and can be taken out again", async () => {
    const s = setup();
    const r = await s.run("mac-agents.sh");
    expect(r.code).toBe(0);
    const base = join(s.home, "Library", "Application Support", "Lamport Sentinel");
    expect(readdirSync(join(base, "bin")).sort()).toEqual(["backup.sh", "check-live.mjs", "watch-from-here.sh"]);
    expect(readFileSync(join(base, "bin", "backup.sh"), "utf8")).toBe(readFileSync(join(root, "sentinel", "backup.sh"), "utf8"));
    const agents = join(s.home, "Library", "LaunchAgents");
    const backup = readFileSync(join(agents, "com.lamportrobotics.sentinel-backup.plist"), "utf8");
    const watch = readFileSync(join(agents, "com.lamportrobotics.sentinel-watch.plist"), "utf8");
    expect(backup).toContain(`<array><string>/bin/sh</string><string>${base}/bin/backup.sh</string><string>can</string></array>`);
    expect(backup).toContain("<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>40</integer></dict>");
    expect(watch).toContain(`<string>${base}/bin/watch-from-here.sh</string>`);
    expect(watch).toContain("<key>StartInterval</key><integer>600</integer>");
    // the copy of the watch script finds the copy of the check beside it
    expect(readFileSync(join(root, "sentinel", "watch-from-here.sh"), "utf8")).toContain('CHECK="${SENTINEL_CHECK:-$HERE/check-live.mjs}"');
    const launch = s.did().filter((a) => a.startsWith("launchctl"));
    expect(launch.filter((a) => a.includes("[bootout]"))).toHaveLength(2);
    expect(launch.filter((a) => a.includes("[bootstrap]")).map((a) => a.split("/").at(-1))).toEqual(["com.lamportrobotics.sentinel-backup.plist]", "com.lamportrobotics.sentinel-watch.plist]"]);
    // no root, no system-wide job
    expect(launch.join("\n")).not.toMatch(/\[system|sudo/);

    const removed = await s.run("mac-agents.sh", ["--remove"]);
    expect(removed.code).toBe(0);
    expect(readdirSync(agents)).toEqual([]);
    expect(existsSync(join(base, "bin", "backup.sh"))).toBe(true); // and nothing else is touched
  }, 30_000);
});
