# Lamport Warden

Browser extension, v0.5. Not released: it is not in the Chrome Web Store, and nobody outside Lamport has
reviewed it. Load it unpacked to try it.

Warden sits in front of whatever Solana wallet you already use. Before a signing request reaches the wallet,
it reads the request, says in one sentence what it will do, and decides how much friction it deserves:

| Level | What you see |
|---|---|
| allow | Nothing. An address and a size you have confirmed before. |
| explain | The sentence, with Cancel and Continue. A first payment to a new address lands here. |
| confirm | The sentence, and you type a short confirmation to continue. |
| block | The sentence and the reason. The request never reaches the wallet. |

What it catches is in the engine, which is the same code the Pincer1 robot runs: account reassignment,
authority handover, unlimited approvals, look-alikes of addresses you have paid, a fee used as a transfer,
sign-now-broadcast-later transactions, a transaction or a raw hash dressed up as a message, and a site asking
for the signature that unlocks your Privacy Rings keys. Privacy Rings deposits and withdrawals are stated with
their public amounts; a private transfer is called what it is, with its amount hidden.

There is no account, no Lamport server and no model. Your payment history stays in the browser's extension
storage on this machine, one history per wallet address, and it grows only when a request you let through
comes back signed.

## Which wallets, and which doors

A page can reach a wallet in more than one way. Warden is tested against the extensions as the Chrome Web
Store ships them (`pnpm test:wallets`; last run against Phantom 26.38.1, Solflare 2.43.0, Backpack 0.10.221.1):

| Wallet | Wallet Standard (what dapps built on wallet-adapter use) | The older object on the window |
|---|---|---|
| Phantom | guarded | guarded: `window.solana`, `window.phantom.solana`, and its `request()` call |
| Backpack | guarded | guarded: `window.backpack`, `window.backpack.solana` |
| Solflare | guarded | **not guarded**: `window.solflare` |

Solflare freezes `window.solflare` and its place on the window, so nothing can be put in front of it. A page
that calls that object directly reaches Solflare without Warden. When Warden meets a door like that on a page,
the settings page lists it.

Sign-in requests (Sign In With Solana) are read too. A sign-in to the site that asks goes through without a
prompt. One that would sign you in to a different site is blocked: that is a page collecting a sign-in to use
somewhere else as you.

It does not matter which extension you installed first. Wallets are guarded by changing the wallet's own
object in place, so the page gets the object it would have got, and Warden puts no name on the window that a
wallet did not put there.

## What leaves your browser

By default, one kind of call. Most swaps are version 0 transactions that name their accounts by position in a
table stored on chain. To say where the money goes, Warden reads that table from a Solana RPC. The RPC learns
which table was asked for and your IP address; it does not learn your wallet address, the transaction or the
site. The default is the public Solana RPC. On the settings page you can point it at your own RPC, or turn it
off, in which case every transaction that uses a table is shown as partly unread.

Simulation is a second kind, and it is off until you turn it on. Warden reads payments and token transfers
exactly; a call to any other program it can only name. With simulation on, such a transaction is sent,
unsigned, to your RPC, which runs it against the chain as it is now. Warden then says what would leave your
wallet and what would arrive, and it sees three things no instruction list shows: a token account handed to
someone else, a delegate given the right to spend, and your wallet's own account reassigned. The RPC sees the
transaction, and the transaction names your wallet. A simulation is a reading of one moment: a program can
behave differently a block later, so it is worded as what a simulation showed, and it can only make a verdict
stricter. A transaction made only of instructions Warden reads in full is never sent.

## How it is put together

| File | Where it runs | Job |
|---|---|---|
| `src/inpage.ts` | the page | Guards every wallet the page can reach, and asks before a signing call goes through. No engine, no history. |
| `src/intercept.ts` | the page | The guarding itself. Pure, tested in Node and in Chromium. |
| `src/content.ts` | isolated, on every page (7 KB) | Carries the request to the background worker and draws the prompt. |
| `src/overlay.ts` | isolated | The prompt, in a closed shadow root in the browser's top layer. A click counts only when the browser marks it as a person's, and Continue only when the browser reports the button was on screen, uncovered and unaltered. |
| `src/background.ts` | the extension's worker | The engine, the history, the lookup-table call. Keeps nothing between messages it could not lose. |
| `src/judge.ts` | worker | Request in, verdict out; records a signed send. Pure, tested in Node. |
| `src/rpc.ts` | worker | Reads lookup tables, and only accounts the lookup table program owns. |
| `src/simulate.ts` | worker | Asks the RPC what a transaction would do, and reads the wallet's accounts before and after. |
| `src/options.ts` | settings page | The RPC, simulation, the sites allowed to ask for Privacy Rings keys, and what Warden remembers. |
| `src/channel.ts` | page and isolated | How the two halves on a page find each other without the page listening in. |

The only permission is `storage`.

## Build, test, load

```
git clone --recurse-submodules https://github.com/Lamport-Robotics/lamport-warden
pnpm install
pnpm typecheck
pnpm test            # the engine glue and the guarding, in Node
pnpm build           # writes dist/
pnpm exec playwright install chromium
pnpm test:browser    # the built extension in Chromium, with stand-in wallets, in both load orders
pnpm test:wallets    # the same in front of the real Phantom, Solflare and Backpack (downloads them)
```

Chrome: `chrome://extensions`, turn on Developer mode, Load unpacked, choose `dist`. The toolbar button opens
the settings page.

Run `pnpm test:wallets` before a release. The wallets change how they put themselves on the page without
notice, and that test is the only thing that will say so.

## Publishing to the Chrome Web Store

`pnpm package` builds and writes `lamport-warden-<version>.zip`, the file the developer dashboard takes.
`store/listing.md` has every text field of the listing and the privacy tab; `store/screenshots/` has the
1280 x 800 screenshots (`pnpm shots` retakes them from the built extension); `PRIVACY.md` is the privacy
policy, also served at https://warden.lamportrobotics.com/privacy/. Run `pnpm test:wallets` first.

## Sentinel

`sentinel/program` is the first piece of Warden Sentinel: the on-chain program that lets a rescue service move
an owner's tokens into that owner's own Lamport Vault and nowhere else. Devnet only, not deployed. It has its
own README, toolchain (Rust and Agave) and CI job.

Arming Sentinel asks for exactly what Warden blocks: an unlimited approval to an address that is not a
program, and transfers signed now to be sent later. `src/sentinel.ts` recognises Sentinel's own transactions
by their exact shape and explains them, and only on the Sentinel page. From any other site, every call to the
Sentinel program is blocked: the real program pointed at someone else's vault is a way to drain a wallet.
Setting it up, or changing the vault, asks you to retype the end of the vault's address, because whoever holds
that vault's 24 words receives a rescue.

`sentinel/vectors/instructions.json` holds the program's instructions as bytes. The program's test suite
writes that file and runs each instruction through the compiled program; Warden's tests read the same file.

## The engine is pinned

`pincer1/` is the [Pincer1 repo](https://github.com/Lamport-Robotics/pincer1) at one commit. The decoder
and the rules stay there because they are tested against the robot's firmware with shared vectors; this
repo takes them as they are. To move to a newer engine: `git -C pincer1 fetch && git -C pincer1 checkout
<commit>`, run the tests, commit the new pin.

## What it is not

Warden is advice in front of your wallet, not a lock on it. A page can still reach a wallet in ways Warden
never sees, and turning the extension off removes it. On Pincer1 the same rules are enforced by the robot's
controller, where a compromised computer cannot talk them away.

Not built yet: token names beyond a handful of well-known ones (others show as a shortened mint address),
Firefox, mobile and agent policy. The icons are the Lamport mark on a light tile until there is a drawn one.
It has been run against the real wallets only as far as the prompt: no test has a funded wallet sign a real
transaction through it.
