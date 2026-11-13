/**
 * Sign In With Solana, the service's side. An owner proves a wallet is theirs by signing a short text the
 * wallet itself writes: "<site> wants you to sign in with your Solana account: <address>", with a number the
 * service issued a moment ago.
 *
 * Four things make a signature count, and each closes a door:
 *   - the site named in the text is this service's own page (a signature collected by another site is for
 *     that site, and Warden blocks a page that asks for one naming somewhere else);
 *   - the number is one this service issued, for this purpose, not long ago, and it is used once;
 *   - the address in the text is the one whose key signed it;
 *   - the signature is over exactly the bytes shown.
 *
 * Nothing is stored about a sign-in but the session that follows it.
 */
import { randomBytes } from "node:crypto";
import { verifyWalletSignature } from "./crypto.js";

export const SIGN_IN_STATEMENT = "Sign in to Warden Sentinel.";
export const LINK_STATEMENT = "Add this wallet to my Warden Sentinel profile.";

const HEADER = / wants you to sign in with your Solana account:$/;
const FIELD = /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID): (.*)$/;

export interface SignInText {
  domain: string;
  address: string;
  statement: string | null;
  fields: Record<string, string>;
}

/** Reads the text a wallet signed. Null when it is not a sign-in text. */
export function parseSignInText(text: string): SignInText | null {
  if (text.length > 2000) return null;
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  if (!HEADER.test(header)) return null;
  const domain = header.replace(HEADER, "");
  const address = lines[1] ?? "";
  if (!domain || /\s/.test(domain) || !address) return null;
  const fields: Record<string, string> = {};
  const statement: string[] = [];
  for (const line of lines.slice(2)) {
    const m = FIELD.exec(line);
    if (m) { if (m[1]! in fields) return null; fields[m[1]!] = m[2]!; continue; }
    if (line.startsWith("Resources:") || line.startsWith("- ")) continue;
    // free text after the fields began is not part of any sign-in text a wallet writes
    if (Object.keys(fields).length > 0 && line.trim() !== "") return null;
    if (line.trim() !== "") statement.push(line);
  }
  return { domain, address, statement: statement.length ? statement.join("\n") : null, fields };
}

/** What a number was issued for: signing in, or adding a wallet to the profile that asked. */
export type Purpose = { kind: "signin" } | { kind: "link"; profile: string };

/** The numbers issued and not yet used. In memory only: one that is lost in a restart is asked for again. */
export class NonceBook {
  private issued = new Map<string, { purpose: Purpose; expiresAt: number }>();
  constructor(private ttlSeconds = 300, private max = 10_000) {}

  issue(purpose: Purpose, now: number): string {
    this.sweep(now);
    // a full book drops its oldest: an owner in the middle of signing in asks again
    if (this.issued.size >= this.max) this.issued.delete(this.issued.keys().next().value!);
    const nonce = randomBytes(16).toString("hex");
    this.issued.set(nonce, { purpose, expiresAt: now + this.ttlSeconds });
    return nonce;
  }

  /** Uses the number up, whatever comes of the attempt, and says what it was for. */
  take(nonce: string, now: number): Purpose | null {
    const entry = this.issued.get(nonce);
    if (!entry) return null;
    this.issued.delete(nonce);
    return entry.expiresAt > now ? entry.purpose : null;
  }

  private sweep(now: number): void {
    for (const [nonce, entry] of this.issued) if (entry.expiresAt <= now) this.issued.delete(nonce);
  }
}

export type SignInResult = { ok: true; address: string; purpose: Purpose } | { ok: false; why: string };

const time = (s: string | undefined): number | null => { if (!s) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : Math.floor(t / 1000); };

/**
 * Checks one signed sign-in text.
 * @param host the site the text must name, as the owner's browser shows it (host, with a port if it has one)
 */
export function verifySignIn(input: { message: Uint8Array; signature: Uint8Array; address: string }, host: string, nonces: NonceBook, now: number): SignInResult {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.message); } catch { return { ok: false, why: "the signed text is not text." }; }
  const parsed = parseSignInText(text);
  if (!parsed) return { ok: false, why: "that is not a sign-in text." };
  // the number is used up before anything else is looked at: one text, one try
  const purpose = parsed.fields["Nonce"] ? nonces.take(parsed.fields["Nonce"], now) : null;
  if (!purpose) return { ok: false, why: "the sign-in number is missing, already used, or too old. Start again." };
  if (parsed.domain.toLowerCase() !== host.toLowerCase()) return { ok: false, why: `that text signs in to ${parsed.domain.slice(0, 80)}, not to this site.` };
  if (parsed.address !== input.address) return { ok: false, why: "the text names a different wallet than the one that signed." };
  const expected = purpose.kind === "link" ? LINK_STATEMENT : SIGN_IN_STATEMENT;
  if (parsed.statement !== expected) return { ok: false, why: "the text does not say what this number was issued for." };
  if (parsed.fields["URI"]) {
    let uriHost: string | null = null;
    try { uriHost = new URL(parsed.fields["URI"]).host.toLowerCase(); } catch { /* not a URL */ }
    if (uriHost !== host.toLowerCase()) return { ok: false, why: "the text points at another site." };
  }
  const issued = time(parsed.fields["Issued At"]);
  if (parsed.fields["Issued At"] && (issued === null || Math.abs(now - issued) > 600)) return { ok: false, why: "the text was written too long ago. Start again." };
  const expires = time(parsed.fields["Expiration Time"]);
  if (parsed.fields["Expiration Time"] && (expires === null || expires <= now)) return { ok: false, why: "the text has expired. Start again." };
  const notBefore = time(parsed.fields["Not Before"]);
  if (parsed.fields["Not Before"] && (notBefore === null || notBefore > now)) return { ok: false, why: "the text is not valid yet." };
  if (!verifyWalletSignature(input.address, input.message, input.signature)) return { ok: false, why: "the signature is not that wallet's." };
  return { ok: true, address: input.address, purpose };
}

/** The text a page asks a wallet to sign when the wallet has no sign-in feature of its own. The same words either way. */
export function signInText(o: { host: string; address: string; nonce: string; purpose: Purpose["kind"]; issuedAt: string }): string {
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
