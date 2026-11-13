# Lamport Warden

Browser extension, v0.

Warden sits in front of whatever Solana wallet you already use. Before a signing request reaches the wallet,
it reads the request, says in one sentence what it will do, and decides how much friction it deserves:

| Level | What you see |
|---|---|
| allow | Nothing. An address and a size you have confirmed before. |
| explain | The sentence, with Cancel and Continue. A first payment to a new address lands here. |
| confirm | The sentence, and you retype the last four characters of the address to continue. |
| block | The sentence and the reason. The request never reaches the wallet. |

What it catches is in the engine, which is the same code the Pincer1 robot runs. It lives in the Pincer1
repo (`daemon/src/warden`) and comes in here as a git submodule pinned to one commit: account reassignment, authority handover, unlimited approvals,
look-alikes of addresses you have paid, a fee used as a transfer, sign-now-broadcast-later transactions, a
transaction or a raw hash dressed up as a message, and a site asking for the signature that unlocks your
Privacy Rings keys. Privacy Rings deposits and withdrawals are stated with their public amounts; a private
transfer is called what it is, with its amount hidden.

There is no account, no server and no model. Your payment history stays in the browser's extension storage on
this machine, one history per wallet address, and it grows only when a request you let through comes back
signed.

## How it is put together

| File | World | Job |
|---|---|---|
| `src/inpage.ts` | page | Wraps every wallet the page can reach (Wallet Standard, and the older `window.solana` style) so each signing call asks first. Holds no engine and no history. |
| `src/intercept.ts` | page | The wrapping itself. Pure, tested in Node. |
| `src/content.ts` | isolated | Engine, history and the prompt. The page cannot run code here. |
| `src/judge.ts` | isolated | Request in, verdict out; records a signed send. Pure, tested in Node. |
| `src/overlay.ts` | isolated | The prompt, in a closed shadow root. Only clicks and typing the browser marks as coming from a person count. |
| `src/channel.ts` | both | How the halves find each other without the page listening in. |

## Build and load

```
git clone --recurse-submodules <this repo>
pnpm install
pnpm test        # 25 tests, including both halves running together
pnpm build       # writes dist/
```

Chrome: `chrome://extensions`, turn on Developer mode, Load unpacked, choose `dist`.

## The engine is pinned

`pincer1/` is the [Pincer1 repo](https://github.com/Lamport-Robotics/pincer1) at one commit. The decoder
and the rules stay there because they are tested against the robot's firmware with shared vectors; this
repo takes them as they are. To move to a newer engine: `git -C pincer1 fetch && git -C pincer1 checkout
<commit>`, run the tests, commit the new pin.

To let a site ask for your Privacy Rings key signature, add its origin to `ringSites` in the extension's
storage. There is no settings page yet.

## What it is not

Warden is advice in front of your wallet, not a lock on it. A page can still reach a wallet in ways Warden
never sees, and turning the extension off removes it. On Pincer1 the same rules are enforced by the robot's
controller, where a compromised computer cannot talk them away.

Not built yet: simulation, a settings page, Firefox, agent policy. The icons are the Pincer1 ones for now.
The content script carries the whole engine (about 500 KB unminified) into every page; moving it to a
background worker is the next step. Nothing here has been run against a real wallet in a real browser yet:
the tests drive it with a stand-in window.
