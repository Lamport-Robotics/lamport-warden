/**
 * What is normal for one wallet, built from its public history only: who it paid, which programs it used,
 * how much it usually sends, and at which hours it transacts.
 *
 * The same rule as Warden's memory in the browser: only a send the wallet itself signed builds trust.
 * Something that arrives teaches nothing, so dust from a look-alike address never becomes "an address this
 * wallet knows". The browser's own memory is never uploaded; this is rebuilt from the chain.
 */
import { OwnerMemory, destinationsOf, recordConfirmed, type MemoryState } from "../../../pincer1/daemon/src/warden/index.js";
import { decode, movementOf, type ObservedTx } from "./observed.js";

export interface BaselineState {
  memory: MemoryState;
  /** How many of the wallet's own transactions fell in each hour of the day, UTC. */
  hours: number[];
  /** How many of the wallet's own transactions it rests on. */
  transactions: number;
}

export class Baseline {
  private constructor(readonly memory: OwnerMemory, readonly hours: number[], public transactions: number) {}

  static empty(): Baseline {
    return new Baseline(new OwnerMemory(), new Array<number>(24).fill(0), 0);
  }

  static from(state: unknown): Baseline {
    const s = state as Partial<BaselineState> | null;
    if (!s || !Array.isArray(s.hours) || s.hours.length !== 24 || typeof s.transactions !== "number") return Baseline.empty();
    return new Baseline(OwnerMemory.from(s.memory), s.hours.map((n) => Number(n) || 0), s.transactions);
  }

  toJSON(): BaselineState {
    return { memory: this.memory.toJSON(), hours: [...this.hours], transactions: this.transactions };
  }

  /**
   * Takes one confirmed transaction into the baseline. Only a transaction the wallet signed, that succeeded,
   * counts at all; and it adds to "who this wallet pays" only when value left the wallet in it.
   */
  learn(tx: ObservedTx, wallet: string): void {
    if (tx.failed) return;
    const parsed = decode(tx, wallet);
    if (!parsed || !parsed.signers.includes(wallet)) return;
    this.transactions += 1;
    if (tx.blockTime !== null) this.hours[new Date(tx.blockTime * 1000).getUTCHours()]! += 1;
    const moved = movementOf(tx, wallet);
    const sent = parsed.lamportsOut > 0n || parsed.tokenOut.length > 0 || moved.lamports < -BigInt(tx.fee) || moved.tokens.some((t) => t.delta < 0n);
    if (!sent) return;
    // Who it paid: the destinations the instructions name. Value that left through a program (a swap) names
    // none, and the pool on the other side is not someone this wallet "pays"; the program is still one it uses.
    this.memory.recordConfirmedSend({
      destinations: destinationsOf(parsed),
      lamports: parsed.lamportsOut,
      solDest: parsed.lamportsOut > 0n ? parsed.dest : null,
      programs: parsed.programs,
      at: tx.blockTime ?? 0,
    });
  }

  /** "This was me": the owner says a payment was theirs, so its destination is one this wallet pays. */
  confirm(tx: ObservedTx, wallet: string): void {
    const parsed = decode(tx, wallet);
    if (parsed) recordConfirmed(this.memory, parsed, tx.blockTime ?? 0);
  }

  /** True when the wallet has enough history to say an hour is one it never transacts in. */
  neverAt(hour: number): boolean {
    return this.transactions >= 20 && this.hours[hour] === 0;
  }
}
