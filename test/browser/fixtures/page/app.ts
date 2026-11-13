/**
 * The page side of the browser tests: a dapp built on the published @wallet-standard/app, plus the older
 * ways of reaching a wallet. window.__app is what the tests drive.
 */
import { getWallets } from "@wallet-standard/app";

const w = window as any;
// what the page saw before it did anything: Warden must not have put names on the window ahead of a wallet
w.__before = { solana: "solana" in window, phantom: "phantom" in window, solflare: "solflare" in window, backpack: "backpack" in window };
w.__errors = [];
window.addEventListener("error", (e) => w.__errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => w.__errors.push(`unhandled: ${String((e as PromiseRejectionEvent).reason?.message ?? (e as PromiseRejectionEvent).reason)}`));

const wallets = getWallets();
const bytes = (a: number[]) => Uint8Array.from(a);
/** A transaction object as web3.js hands one to an injected provider. */
const txObject = (a: number[], versioned: boolean) => (versioned ? { version: 0, message: { serialize: () => new Uint8Array(1) }, serialize: () => bytes(a) } : { instructions: [], serialize: () => bytes(a) });

const results: Record<string, string> = {};
w.__results = results;

w.__app = {
  names: () => wallets.get().map((x) => x.name),
  count: (name: string) => wallets.get().filter((x) => x.name === name).length,
  /** Starts a signing call and files how it ended under `tag`: "signed", or the error's name. */
  start(tag: string, door: string, kind: "tx" | "msg" | "send" | "all" | "request" | "signin", payload: any, versioned = false) {
    let p: Promise<unknown>;
    if (door.startsWith("standard:")) {
      // a wallet may register one object per chain under one name: take the one that signs for Solana
      const feature = kind === "msg" ? "solana:signMessage" : kind === "signin" ? "solana:signIn" : kind === "send" ? "solana:signAndSendTransaction" : "solana:signTransaction";
      const wallet: any = wallets.get().find((x) => x.name === door.slice(9) && feature in x.features);
      const account = wallet.accounts[0]; // undefined until the wallet is connected
      if (kind === "msg") p = wallet.features["solana:signMessage"].signMessage({ account, message: bytes(payload as number[]) });
      else if (kind === "signin") p = payload === null ? wallet.features["solana:signIn"].signIn() : wallet.features["solana:signIn"].signIn(payload);
      else if (kind === "send") p = wallet.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain: "solana:mainnet", transaction: bytes(payload as number[]) });
      else if (kind === "all") p = wallet.features["solana:signTransaction"].signTransaction(...(payload as number[][]).map((t) => ({ account, transaction: bytes(t) })));
      else p = wallet.features["solana:signTransaction"].signTransaction({ account, transaction: bytes(payload as number[]) });
    } else {
      const provider = door.split(".").reduce((o: any, k) => o?.[k], w);
      if (kind === "msg") p = provider.signMessage(bytes(payload as number[]));
      else if (kind === "signin") p = provider.signIn(payload ?? undefined);
      else if (kind === "send") p = provider.signAndSendTransaction(txObject(payload as number[], versioned));
      else if (kind === "all") p = provider.signAllTransactions((payload as number[][]).map((t) => txObject(t, versioned)));
      else if (kind === "request") p = provider.request({ method: "signAndSendTransaction", params: { message: payload } });
      else p = provider.signTransaction(txObject(payload as number[], versioned));
    }
    results[tag] = "pending";
    p.then(() => { results[tag] = "signed"; }, (e) => { results[tag] = String(e?.name ?? e); });
  },
};
