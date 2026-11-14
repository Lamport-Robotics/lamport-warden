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
 * Lamport's decoys: wallets Lamport funds for this purpose and keeps the keys of. The keys are not in the
 * extension, so nothing a site asks one of them to sign can be signed by it.
 *
 * None in this build. With none here, a site is shown a decoy only when the owner has named an address of
 * their own in the settings. (They are public, like everything on the chain: a thief can learn them and ask
 * them for nothing. The README says what that leaves.)
 */
export const LAMPORT_DECOYS: readonly string[] = [];
