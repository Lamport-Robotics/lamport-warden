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
  | { type: "doors"; unguarded: string[] };

export type JudgeReply = { ok: true; verdict: WireVerdict } | { ok: false };
