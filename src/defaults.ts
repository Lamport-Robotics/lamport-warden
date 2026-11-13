/** Where lookup tables are read from unless the owner says otherwise. Kept apart so the settings page does not pull in the engine. */
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/** The one site that may set Sentinel up or change it, and the only page the extension answers about Sentinel. */
export const ARMING_ORIGIN = "https://warden.lamportrobotics.com";
/** Where an owner sets Sentinel up. */
export const SENTINEL_PAGE = `${ARMING_ORIGIN}/sentinel/`;
/** Where "this signature was mine" is sent, when the owner turned that on. Fixed here: never taken from a page. */
export const SENTINEL_API = `${ARMING_ORIGIN}/sentinel/api`;
