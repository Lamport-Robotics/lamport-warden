/** Where lookup tables are read from unless the owner says otherwise. Kept apart so the settings page does not pull in the engine. */
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/** The one site that may set Sentinel up or change it, and the only page the extension answers about Sentinel. */
export const ARMING_ORIGIN = "https://warden.lamportrobotics.com";
/** A page with a practice wallet, where anyone can watch Warden read a request. Only ever opened by a click. */
export const PRACTICE_PAGE = `${ARMING_ORIGIN}/try/`;
/** Where an owner sets Sentinel up. */
export const SENTINEL_PAGE = `${ARMING_ORIGIN}/sentinel/`;
/** Where "this signature was mine" is sent, when the owner turned that on. Fixed here: never taken from a page. */
export const SENTINEL_API = `${ARMING_ORIGIN}/sentinel/api`;
/**
 * $LAMPORT, and how many decimal places it has. Both are fixed for good: the token has no authority that could
 * mint it or change it. Warden names this one token, so that burning it to pay for Sentinel can be said in
 * whole tokens (sentinel.ts).
 */
export const LAMPORT_MINT = "D4CzGsZgusVj2K8R1its5H8WWdo9mazbDwBc6qvsmfun";
export const LAMPORT_DECIMALS = 6;
