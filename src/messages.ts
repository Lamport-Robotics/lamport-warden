/** What the content script and the background worker say to each other. Plain JSON: it crosses chrome.runtime. */
import type { WardenVerdict } from "../pincer1/daemon/src/warden/index.js";
import type { PageAsk } from "./sentinel-link.js";

/** A signing request as the page-world script reported it. `bytes` is base64. */
export interface WireRequest { kind: "tx" | "msg" | "signin" | "opaque"; bytes: string; owner: string }
/** The verdict without the decoded transaction, which holds values JSON cannot carry. */
export type WireVerdict = Pick<WardenVerdict, "level" | "sentence" | "reasons" | "confirm">;

export type ToBackground =
  | { type: "judge"; req: WireRequest }
  /**
   * The owner let it through and the wallet signed it. Sent with the request itself: the worker may have slept
   * in between. `sigs`: the signatures in the wallet's answer, base64, in the transaction's order.
   */
  | { type: "signed"; req: WireRequest; sigs?: string[] }
  /** From the Sentinel page, and only from it: link or unlink a wallet for reporting, or ask what is linked. */
  | { type: "sentinel"; ask: PageAsk }
  /** Wallet doors on the page that could not be guarded, by the name they have on the window. */
  | { type: "doors"; unguarded: string[] }
  /** Decoy first: may this page be shown a decoy before the owner's wallet, and which? */
  | { type: "decoy-first" }
  /** Decoy first: the page asked the decoy (their `owner`) to sign these, in one call. Was that a robbery? */
  | { type: "decoy-asked"; reqs: WireRequest[] }
  /** Decoy first: the owner chose to go on with their own wallet on this site. It is not shown a decoy again. */
  | { type: "decoy-passed" };

export type JudgeReply = { ok: true; verdict: WireVerdict } | { ok: false };
/** The worker has written down what it was told. */
export type Noted = { noted: boolean };
/** `caughtOn`: the day this site was caught asking a decoy for what only a thief asks, when it has been. */
export type DecoyFirstReply = { address: string | null; caughtOn?: string | null };
/**
 * `caught`: the site asked the decoy for what only a thief asks. The verdict is what the owner is shown either
 * way; null when there is nothing to show because this site has passed already (in another tab, say).
 */
export type DecoyAskedReply = { ok: true; caught: boolean; verdict: WireVerdict | null } | { ok: false };
