/**
 * The words of a sign-in, shared by the service that checks them and the page that asks a wallet to sign
 * them. Nothing here but text: the page bundles this file.
 */
export const SIGN_IN_STATEMENT = "Sign in to Warden Sentinel.";
export const LINK_STATEMENT = "Add this wallet to my Warden Sentinel profile.";

/** The text a page asks a wallet to sign when the wallet has no sign-in feature of its own. The same words either way. */
export function signInText(o: { host: string; address: string; nonce: string; purpose: "signin" | "link"; issuedAt: string }): string {
  return [
    `${o.host} wants you to sign in with your Solana account:`,
    o.address,
    "",
    o.purpose === "link" ? LINK_STATEMENT : SIGN_IN_STATEMENT,
    "",
    `Nonce: ${o.nonce}`,
    `Issued At: ${o.issuedAt}`,
  ].join("\n");
}
