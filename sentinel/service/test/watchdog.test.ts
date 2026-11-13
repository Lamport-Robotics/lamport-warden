/**
 * The watchdog that runs beside the service on the server (sentinel/watchdog.sh), run here for real: the
 * script itself, the check it shares with the one from outside, and stand-ins for the two commands it uses
 * to act (systemctl, curl), which only write down what they were asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const now = () => Math.floor(Date.now() / 1000);
const OPS = "https://ntfy.sh/operator-topic-123";

let server: Server, url = "";
/** What the service's health address answers, one after another; the last one is repeated. */
let answers: (Record<string, unknown> | "nothing")[] = [];

beforeAll(async () => {
  server = createServer((_req, res) => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a === "nothing") { res.destroy(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(a));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/health`;
});
afterAll(() => { server?.close(); });

function setup(channel: string | null = OPS) {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-watchdog-"));
  const acts = join(dir, "acts.log");
  for (const name of ["systemctl", "curl"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s' "${name}" >> "${acts}"\nfor a in "$@"; do printf ' [%s]' "$a" >> "${acts}"; done\nprintf '\\n' >> "${acts}"\nexit 0\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const envFile = join(dir, "sentinel.env");
  writeFileSync(envFile, `SENTINEL_RPC_URL=https://rpc.example\n${channel ? `SENTINEL_OPS_CHANNEL=${channel}\n` : ""}SENTINEL_PORT=8791\n`);
  const stamp = join(dir, "told");
  const run = (healthUrl = url): Promise<{ code: number | null; out: string; acts: string[] }> => new Promise((resolve) => {
    const child = spawn("sh", [join(root, "sentinel", "watchdog.sh")], { env: { PATH: `${dir}:${process.env.PATH}`, SENTINEL_HEALTH_URL: healthUrl, SENTINEL_ENV_FILE: envFile, SENTINEL_CHECK: join(root, "scripts", "check-live.mjs"), SENTINEL_WATCH_STAMP: stamp, SENTINEL_CHECK_ARGS: "--once", SENTINEL_WATCH_AGAIN_AFTER: "0" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out, acts: existsSync(acts) ? readFileSync(acts, "utf8").trim().split("\n").filter(Boolean) : [] }));
  });
  return { run, stamp };
}

const healthy = () => ({ ok: true, watching: 4, lastPassAt: now() - 5, blind: 0, late: 0, push: "on" });
const stalled = () => ({ ok: true, watching: 4, lastPassAt: now() - 3600, blind: 0, late: 0, push: "on" });

describe("the watchdog beside the service", () => {
  it("does nothing while the service is watching", async () => {
    const w = setup();
    answers = [healthy()];
    expect(await w.run()).toMatchObject({ code: 0, out: "", acts: [] });
  }, 20_000);

  it("starts a service again that is up and no longer reading, and tells whoever runs it, once an hour", async () => {
    const w = setup();
    answers = [stalled()];
    const first = await w.run();
    expect(first.code).toBe(0);
    expect(first.acts[0]).toBe("systemctl [restart] [lamport-sentinel.service]");
    expect(first.acts[1]).toMatch(/^curl \[-fsS\] \[-m\] \[10\] \[-H\] \[Title: Warden Sentinel: operations\] \[-d\] \[The watchdog beside Sentinel found it not watching, twice, and started it again\. What it found: Sentinel is not watching: the last round of reading wallets ended 60 minutes ago: the watcher has stopped while the service still answers\.\] \[https:\/\/ntfy\.sh\/operator-topic-123\]$/);
    expect(first.acts).toHaveLength(2);
    expect(first.out).toContain("watchdog: started lamport-sentinel.service again");
    expect(Number(readFileSync(w.stamp, "utf8"))).toBeGreaterThan(now() - 10);
    // still stalled five minutes later: started again, and not said again
    const second = await w.run();
    expect(second.acts.slice(2)).toEqual(["systemctl [restart] [lamport-sentinel.service]"]);
  }, 30_000);

  it("looks twice before acting: a service that has only just started is left alone", async () => {
    const w = setup();
    answers = [{ ok: true, watching: 4, lastPassAt: null, blind: 0 }, healthy()];
    expect(await w.run()).toMatchObject({ code: 0, acts: [] });
  }, 20_000);

  it("leaves it alone when the trouble is the RPC, which starting it again would not help", async () => {
    const w = setup();
    answers = [{ ok: true, watching: 4, lastPassAt: now() - 5, blind: 4, late: 0 }];
    const r = await w.run();
    expect(r.acts).toEqual([]);
    expect(r.out).toContain("not restarted: the RPC is the trouble");
  }, 20_000);

  it("starts it again when it does not answer at all, and posts only where a plain line is taken", async () => {
    const quiet = setup(null); // no operator channel: started again, nobody to tell
    answers = ["nothing"];
    expect((await quiet.run()).acts).toEqual(["systemctl [restart] [lamport-sentinel.service]"]);
    // a Discord channel wants its own form: nothing is posted there by a shell script
    const discord = setup(["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/"));
    expect((await discord.run()).acts).toEqual(["systemctl [restart] [lamport-sentinel.service]"]);
    // and an address that is not https is never posted to
    const plain = setup("http://ntfy.sh/operator-topic-123");
    expect((await plain.run()).acts).toEqual(["systemctl [restart] [lamport-sentinel.service]"]);
  }, 40_000);

  it("is what the deployment installs, on a timer", () => {
    const deploy = readFileSync(join(root, "sentinel", "deploy.sh"), "utf8");
    expect(deploy).toContain("scp -q scripts/check-live.mjs sentinel/watchdog.sh");
    expect(deploy).toContain("ExecStart=/bin/sh /opt/lamport-sentinel/watchdog.sh");
    expect(deploy).toContain("OnUnitActiveSec=5min");
    expect(deploy).toContain("systemctl enable -q --now lamport-sentinel-watch.timer");
  });
});
