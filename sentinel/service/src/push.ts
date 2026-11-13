/**
 * Hears of a wallet's transactions as they happen.
 *
 * The RPC is asked, over one websocket, to say when a watched address is mentioned in a transaction
 * (`logsSubscribe` with `mentions`). When it does, the wallet is read at once instead of at its next turn, so
 * an alert follows a transaction by seconds and not by up to a minute.
 *
 * Nothing that is pushed is believed. A notification is only a reason to read: what happened is then read
 * from the RPC the same way as on any other pass, and the rules run on that. And nothing depends on it: if
 * the socket is down, or the RPC never says anything, every wallet is still read at the pace its plan
 * promises. This makes the watching faster when it works and changes nothing when it does not.
 */

/** As much of a WebSocket as this uses: the browser's interface, which Node has too. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export interface PushOptions {
  /** The RPC's websocket address. */
  url: string;
  /** Called with a watched wallet's address when the RPC says a transaction mentioned it. */
  onMention: (wallet: string) => void;
  socket?: (url: string) => SocketLike;
  log?: (line: string) => void;
  /**
   * How many subscriptions one connection carries (default 90), how many connections there may be (default
   * 5), and how many new subscriptions are asked for at a time (default 20, each time the wallets are given).
   * Measured on the public Solana RPC on 2026-11-13: a connection is closed at its hundred-and-first
   * subscription ("Too many subscriptions attempted. Please open a new connection"); a sixth connection from
   * one address is closed as it opens; and a connection that asks for two hundred subscriptions in a second
   * is closed, where ten a second are all taken. So the wallets are spread over several connections and asked
   * for gradually. A wallet beyond what they carry between them is not pushed, and is read in turn like before.
   */
  perLine?: number;
  lines?: number;
  perSync?: number;
  /** Timers, so a test can run them by hand. */
  later?: (work: () => void, ms: number) => unknown;
}

/** An address as Solana writes one: nothing else is ever put in a subscription. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One connection, and the wallets listened for on it. */
class PushLine {
  private socket: SocketLike | null = null;
  private open = false;
  private stopped = false;
  private nextId = 1;
  /** Requests waiting for their answer: a subscription being made, or the question that checks the line. */
  private asked = new Map<number, { wallet: string } | { check: true }>();
  /** The RPC's number for each subscription, and back. */
  private byNumber = new Map<number, string>();
  private numberOf = new Map<string, number>();
  private pending = new Set<string>();
  private wanted: string[] = [];
  private failures = 0;
  private unanswered = 0;

  constructor(private o: PushOptions, private most: number) {}

  private later(work: () => void, ms: number): void { const t = (this.o.later ?? ((w, m) => setTimeout(w, m)))(work, ms); (t as { unref?: () => void } | undefined)?.unref?.(); }
  private log(line: string): void { (this.o.log ?? console.error)(`sentinel: ${line}`); }

  /** Whether the line is up, and how many wallets it is listening for. */
  get state(): { connected: boolean; listening: number } { return { connected: this.open, listening: this.numberOf.size }; }

  start(): void { this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    this.open = false;
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
  }

  /** The wallets to listen for now. Called every round: new ones are subscribed, ones no longer watched are dropped. */
  /**
   * The wallets to listen for on this connection. No more than `budget` new subscriptions are asked for in one
   * call (the RPC closes a connection that asks for many at once); the rest are asked for on the next.
   * Returns how many were asked for.
   */
  watch(wallets: string[], budget = Infinity): number {
    this.wanted = wallets.filter((w) => ADDRESS.test(w)).slice(0, this.most);
    if (!this.open) return 0;
    const want = new Set(this.wanted);
    let asked = 0;
    for (const w of this.wanted) {
      if (asked >= budget) break;
      if (!this.numberOf.has(w) && !this.pending.has(w)) { this.subscribe(w); asked += 1; }
    }
    for (const [w, n] of this.numberOf) {
      if (want.has(w)) continue;
      this.numberOf.delete(w);
      this.byNumber.delete(n);
      this.sendJson({ jsonrpc: "2.0", id: this.nextId++, method: "logsUnsubscribe", params: [n] });
    }
    return asked;
  }

  /**
   * Asks the line a question it has to answer, to learn whether it is still there: a quiet wallet says
   * nothing for days, and a dead socket says nothing either. Two questions in a row without an answer and the
   * line is taken down and put up again. Called from the round, about twice a minute.
   */
  check(): void {
    if (!this.open) return;
    if (this.unanswered >= 2) { this.log("the push line stopped answering; reconnecting"); this.drop(); return; }
    this.unanswered += 1;
    const id = this.nextId++;
    this.asked.set(id, { check: true });
    // unsubscribing from a subscription that does not exist: the RPC answers with an error at once, which is all that is wanted
    this.sendJson({ jsonrpc: "2.0", id, method: "logsUnsubscribe", params: [0] });
  }

  private subscribe(wallet: string): void {
    const id = this.nextId++;
    this.pending.add(wallet);
    this.asked.set(id, { wallet });
    this.sendJson({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [wallet] }, { commitment: "confirmed" }] });
  }

  private sendJson(message: unknown): void {
    try { this.socket?.send(JSON.stringify(message)); } catch { this.drop(); }
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: SocketLike;
    try { socket = (this.o.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(this.o.url); } catch (e) { this.log(`the push line could not be opened: ${String((e as Error).message ?? e).slice(0, 120)}`); this.retry(); return; }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.failures = 0;
      this.unanswered = 0;
      // what to listen for is asked for a few at a time, by the next call to `watch`: all of it at once is refused
    });
    socket.addEventListener("message", (event) => { if (this.socket === socket) this.heard(event?.data); });
    const gone = () => { if (this.socket === socket) this.drop(); };
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
  }

  /** The line is gone: forget what was subscribed on it, and put it up again after a wait that grows. */
  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.asked.clear();
    this.byNumber.clear();
    this.numberOf.clear();
    this.pending.clear();
    try { socket?.close(); } catch { /* already gone */ }
    this.retry();
  }

  private retry(): void {
    if (this.stopped) return;
    this.failures += 1;
    this.later(() => { if (!this.socket) this.connect(); }, Math.min(60_000, 1000 * 2 ** Math.min(this.failures - 1, 6)));
  }

  private heard(data: unknown): void {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.method === "logsNotification") {
      const wallet = this.byNumber.get(m.params?.subscription);
      // only a wallet that is listened for, by the number the RPC gave for it: what the message says of itself is not used
      if (wallet) this.o.onMention(wallet);
      return;
    }
    const asked = typeof m.id === "number" ? this.asked.get(m.id) : undefined;
    if (!asked) return;
    this.asked.delete(m.id);
    if ("check" in asked) { this.unanswered = 0; return; }
    this.pending.delete(asked.wallet);
    if (typeof m.result === "number" && this.wanted.includes(asked.wallet)) { this.byNumber.set(m.result, asked.wallet); this.numberOf.set(asked.wallet, m.result); }
    // a subscription the RPC would not take is not asked for again on this connection: the wallet is read in turn, as always
    else if (m.error) this.pending.add(asked.wallet);
  }
}

/**
 * The push line: as many connections as the watched wallets need, each carrying no more than the RPC takes on
 * one. A wallet stays on the connection it is on; a new one goes where there is room, and a connection is
 * opened when there is none; one left with nobody on it is closed.
 */
export class Push {
  private lines: { line: PushLine; wallets: string[] }[] = [];
  private started = false;
  private perLine: number;
  private most: number;

  constructor(private o: PushOptions) {
    this.perLine = Math.max(1, o.perLine ?? 90);
    this.most = Math.max(1, o.lines ?? 5);
    this.open(); // one is kept even with nobody to listen for, so that it is known whether the RPC can be reached this way
  }

  private open(): { line: PushLine; wallets: string[] } {
    const entry = { line: new PushLine(this.o, this.perLine), wallets: [] as string[] };
    this.lines.push(entry);
    if (this.started) entry.line.start();
    return entry;
  }

  /** Whether every connection is up, and how many wallets are being listened for in all. */
  get state(): { connected: boolean; listening: number; lines: number } {
    return { connected: this.lines.every((l) => l.line.state.connected), listening: this.lines.reduce((n, l) => n + l.line.state.listening, 0), lines: this.lines.length };
  }

  start(): void { this.started = true; for (const l of this.lines) l.line.start(); }
  stop(): void { this.started = false; for (const l of this.lines) l.line.stop(); }
  check(): void { for (const l of this.lines) l.line.check(); }

  /** The wallets to listen for now. Called every round. */
  watch(wallets: string[]): void {
    const wanted = [...new Set(wallets.filter((w) => ADDRESS.test(w)))].slice(0, this.perLine * this.most);
    const want = new Set(wanted), placed = new Set<string>();
    for (const l of this.lines) { l.wallets = l.wallets.filter((w) => want.has(w)); for (const w of l.wallets) placed.add(w); }
    for (const w of wanted) {
      if (placed.has(w)) continue;
      const home = this.lines.find((l) => l.wallets.length < this.perLine) ?? (this.lines.length < this.most ? this.open() : null);
      if (!home) break;
      home.wallets.push(w);
    }
    let budget = Math.max(1, this.o.perSync ?? 20);
    for (const l of this.lines) budget -= l.line.watch(l.wallets, budget);
    // nobody left on a connection: it is closed, all but the first
    for (let i = this.lines.length - 1; i >= 1; i--) if (this.lines[i]!.wallets.length === 0) { this.lines[i]!.line.stop(); this.lines.splice(i, 1); }
  }
}

/** The websocket address that goes with an RPC's address. */
export function pushUrlFor(rpcUrl: string): string | null {
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  } catch { return null; }
}
