# Lamport Warden

Browser extension, v0.6. Not released: it is not in the Chrome Web Store (a draft listing is filled in and
waits for the version that carries Sentinel), and nobody outside Lamport has reviewed it. Load it unpacked to
try it.

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

There is no account and no model, and by default nothing goes to Lamport. Your payment history stays in the browser's extension
storage on this machine, one history per wallet address, and it grows only when a request you let through
comes back signed.

## See it work

https://warden.lamportrobotics.com/try/ has a practice wallet that holds nothing, and eight requests a real
site might make of it: a first payment, the same payment again, a look-alike address, an unlimited approval,
a token account handed over, a sign-in for another site, a payment dressed up as a message, and an ordinary
message. With Warden installed, each ends the way the page says it will. Nothing is sent to Solana.
`site/try/` is the page; a new install is offered it once, from Warden's own settings page.

## Which wallets, and which doors

A page can reach a wallet in more than one way. Warden is tested against the extensions as the Chrome Web
Store ships them (`pnpm test:wallets`; last run against Phantom 26.38.1, Solflare 2.43.0, Backpack 0.10.221.1):

| Wallet | Wallet Standard (what dapps built on wallet-adapter use) | The older object on the window |
|---|---|---|
| Phantom | guarded | guarded: `window.solana`, `window.phantom.solana`, and its `request()` call |
| Backpack | guarded | guarded: `window.backpack`, `window.backpack.solana`, and its own `send()` and `sendAndConfirm()` |
| Solflare | guarded | **not guarded**: `window.solflare` |

Solflare freezes `window.solflare` and its place on the window, so nothing can be put in front of it. A page
that calls that object directly reaches Solflare without Warden. When Warden meets a door like that on a page,
the settings page lists it.

Phantom and Backpack answer a request made at their Wallet Standard door by handing it to their own older
object, and Warden stands at both. It asks once: a request the owner has let through may be met again
on its way to the wallet, the same kind, the same account and the same bytes, and is not asked about
again: once more at any door, and once more after that at Backpack's own `send` and `sendAndConfirm`, which
its other methods call. A copy a page sends through the other door itself is a second request, and is asked about (`guarded`
in `src/intercept.ts`).

Whose request it is, Warden takes from the wallet. A page names an account when it asks a Wallet Standard
wallet to sign, and can name any; what a transaction does is read from the side of the account that signs
it. So the page's word is taken only for an account the wallet lists as its own, and otherwise the request
is read as the wallet's own account's; the account handed on to the wallet is the wallet's own object for
that account, when the page named one the wallet lists. At a wallet's older door, where a method may take
the account to sign with as an argument (Backpack's do), the argument is read once, the way Backpack reads
it, and the wallet is handed the address that was read in place of the page's object. The request is read
from that account's side as well as from the wallet's own, or from whichever of the two the transaction
says must sign it. Warden does not ask the wallet's object which wallet it is, and at Backpack's `send` it
does not ask the page's object whether it is a transaction: a page can make either say anything.

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

## A decoy first (an experiment, off unless turned on)

Connecting a wallet to a site hands the site an address and nothing else: nothing is signed. So the first
address a site is handed does not have to be the owner's. With this on, a site Warden has not seen is handed
a decoy's: an address that holds something and whose key is not in the browser, so that nothing it is asked
to sign can be signed.

A site that robs wallets looks up what the connected address holds and asks it to sign that away. A site
that does not, waits for its visitor. So what a site asks the decoy for says what the site is, before it has
seen the owner's address (`src/decoy.ts`):

- it asks the decoy to hand over an account, or to let somebody spend its tokens without limit, or nearly
  all of them, or with nothing in the transaction that would use the permission: caught;
- it asks the decoy to send out most of two or more different things, in transactions that do nothing else:
  caught (a sweep);
- it asks the decoy to send out nine tenths or more of what it holds of something, in transactions that do
  nothing else: caught;
- anything else: it passes. The owner is told, and when they go on their own wallet is connected in the
  decoy's place, the site is told its account changed and to ask again, and Warden reads that request like
  any other.

"Does nothing else" means it calls only programs whose every instruction Warden reads. What is sent out is
added up over everything asked in one call, so a balance taken in pieces is taken. What moves into the
decoy's own accounts is not sent out (wrapping SOL), unless the same transaction takes it out of there:
closes that account to somebody else, sends the wrapped SOL on, or lets somebody spend it. More than the
decoy holds of something is a price and not a balance, and is not counted; what the decoy holds is read
again before that is believed, because it is somebody's live wallet and may have been sent more since. And
when nothing is known of what the decoy holds (the RPC is off, or does not answer), how much is asked says
nothing: only a power handed over catches anybody then, and the owner is told the amounts could not be
weighed. The first sixteen requests of a call are read; a call that asks for more is not gone on with at a
press.

While a site is being shown the decoy, Warden says so in a corner of the page, with a button: **use my
wallet here**. A site that has nothing to ask a wallet for straight away (a portfolio page, a swap form that
first wants a balance) never asks the decoy for anything, and that button is how its visitor goes on.

Where it stands, and what it remembers:

- **Both of a wallet's doors**: its Wallet Standard wallet, and the older object on the window
  (`window.solana.connect()`), which is how the simplest thieving scripts reach a wallet. It answers connect,
  what the wallet says its account is, and the event a site listens for. What a provider hands a page is a
  `PublicKey` of the wallet's own web3.js; `keyLike()` is the decoy's address in that shape.
- **One page, one decoy, one outcome.** Caught at one door, the page gets nothing more through any; passed
  at one, the decoy comes down at all.
- **A wallet the site already knows is left as it is**: one that is already connected, or that answers a
  connect which asked not to prompt. That site has its address already.
- **A site the owner went on to use is not shown a decoy again; a site that was caught is remembered.** On a
  later visit it is shown the decoy again, and going on with it takes typing, not a press.

It is run in Chromium by `test/browser/decoy.test.ts`, on an ordinary site in front of wallets built the way
Phantom, Solflare and Backpack are, and by `pnpm test:wallets` in front of those extensions themselves.

What it is not:

- **It only adds a way of being caught.** A thief that recognises a decoy asks it for nothing, passes, and
  then faces what every site faces: Warden reading each request made of the real wallet. So does one that
  behaves first and robs later, one that adds a call to a program Warden does not read, and one that asks
  the visitor to sign in before it asks them to connect.
- **A decoy can be recognised.** It answers at once with no window from the wallet, and the key it hands a
  page is not the wallet's own kind of object. No list of addresses is needed to tell, so rotating or hiding
  the addresses would buy nothing. A decoy catches the thief that has not adapted to it.
- **The decoy has to be a real address that really holds something**, or a thief that looks it up sees an
  empty wallet. Where the owner names none, Warden finds the browser one of its own (`src/decoy-find.ts`): a
  wallet that paid for a transaction in a block made final a moment ago and holds at least three SOL, picked
  at random and found again each week. No two browsers show the same one, so there is no list of decoys to
  learn, and nothing for anybody to fund. It is a stranger's real wallet: a site that is shown the decoy sees
  that address arrive from the visitor's browser, and may record it. Nothing can be signed for it and nothing
  of its owner's is at risk, but an owner who would rather not show a stranger's address names one of their
  choosing, which must be one they have no key to. `LAMPORT_DECOYS` in `src/defaults.ts` is where wallets
  Lamport funds for this would go; it is empty, and with a decoy found for each browser it can stay so.
- **It can take an honest request for a robbery.** Any plain payment of nine tenths or more of what the
  decoy holds of something is caught like a thief: a "max" button, or a price that happens to be about what
  the decoy holds. So is a permission for nearly all of a holding, whatever uses it. A page that was caught
  gets nothing more until it is loaded again, and the site is remembered. The button in the corner is the
  way round, pressed before the site asks for anything; and "Forget them" in the settings.
- **A page can keep the notice from being pressed.** Its element is in the page: a page that keeps taking it
  out or changing it has it put back each time, and the button does not count for a moment after. A page
  cannot press it. Turning the experiment off in the settings ends a decoy on any page.
- **No answer, no decoy.** If Warden's own worker has not said within three seconds of a page's first
  connect whether that page has a decoy, the page is connected as always.
- **The top frame only.** A page inside a frame is connected as always, and a page that was caught can
  still reach a wallet from inside a frame. Warden reads what is asked there like any other request.
- **Not at Solflare's older door.** Nothing can be put in front of `window.solflare` (see the table above),
  so a page that calls it directly is connected as always. Its Wallet Standard door is covered.
- **Phantom, Backpack and Solflare are the wallets it was shaped against.** Another wallet gets a decoy only
  where Warden can also answer for what that wallet says its account is, and none otherwise.
- **It keeps records Warden otherwise would not**: a mark for each site the owner went on to use and for
  each site that was caught (see the privacy policy). And with it off, Warden still stands in front of each
  wallet's connect, to ask whether the page has a decoy; the answer is no, and the wallet's own list of
  accounts is left untouched.

## How it is put together

| File | Where it runs | Job |
|---|---|---|
| `src/inpage.ts` | the page | Guards every wallet the page can reach, and asks before a signing call goes through. No engine, no history. |
| `src/intercept.ts` | the page | The guarding itself. Pure, tested in Node and in Chromium. |
| `src/content.ts` | isolated, on every page (7 KB) | Carries the request to the background worker and draws the prompt. |
| `src/overlay.ts` | isolated | The prompt, in a closed shadow root in the browser's top layer. A click counts only when the browser marks it as a person's, and Continue only when the browser reports the button was on screen, uncovered and unaltered. |
| `src/background.ts` | the extension's worker | The engine, the history, the lookup-table call. Keeps nothing between messages it could not lose. |
| `src/judge.ts` | worker | Request in, verdict out; records a signed send. Pure, tested in Node. |
| `src/rpc.ts` | worker | Reads lookup tables, and only accounts the lookup table program owns; and one account for the Sentinel page (a wallet's rescue setup, when this browser has not seen it). |
| `src/simulate.ts` | worker | Asks the RPC what a transaction would do, and reads the wallet's accounts before and after. |
| `src/options.ts` | settings page | The RPC, simulation, the sites allowed to ask for Privacy Rings keys, and what Warden remembers. |
| `src/channel.ts` | page and isolated | How the two halves on a page find each other without the page listening in. |
| `src/decoy.ts` | worker | The decoy experiment: what a site asked a decoy for, and whether that is a robbery. Pure, tested in Node. |

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

The settings page has a Sentinel panel: which wallets this browser saw armed, which are linked for
reporting, and one switch, off by default, "Tell Sentinel which signatures were mine". A server sees only the
chain, so it cannot tell the owner's payment from a thief's with the same key. With the switch on, Warden
tells Sentinel the wallet and the signature of a transaction the owner let through, and only when the
wallet's answer proves it: the owner's own key, over the exact bytes Warden read (`src/report.ts`). The
Sentinel page hands over the token a wallet reports with; only that page's top frame is listened to, and the
address reports go to is fixed in the extension (`src/sentinel-link.ts`, `src/defaults.ts`).

`sentinel/service` is the watcher and the server around it: it reads each watched wallet, raises alerts in
plain sentences, and lets an owner sign in with a wallet to choose where alerts go and to answer them. It
holds no key and moves nothing. Not deployed; its README has the API and what the stored file gives away.

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

Said exactly: Warden stops the site that uses a wallet the way sites do. A page written to get round Warden
can, and these are the ways known:

- **It can talk to the wallet without the wallet's object.** A wallet's object on the page is a messenger to
  the wallet's own extension. A page that sends those messages itself never touches what Warden stands in
  front of.
- **It can replace the browser's built-in functions under Warden.** The half of Warden that stands in front
  of a wallet runs in the page's own world and uses the same `Map`, `Promise` and `JSON` the page does. A
  page that replaces them can have Warden ask nothing, or answer for it.
- **At a wallet's older door it can hand over a transaction that changes its mind.** There a transaction is
  an object of the page's, and what it says when the wallet reads it is the page's to decide. Warden reads
  it when asked and again when handing it on, and asks about what it then says; an object written to answer
  differently a third time is not caught. (At the Wallet Standard door a request is bytes, and what the
  wallet is handed is Warden's own copy of the bytes it read. At the older door so are a transaction given
  as bytes, a message as bytes, text or a list, and the fields of a sign-in or a `request()` call, each read
  once; a sign-in field that is not text is made text before it is read, and that text is what is handed
  on.)

In each of these the wallet's own window still shows what it is asked to sign. What a page cannot reach is
what is inside the prompt, the history of who a wallet has paid, and what Warden remembers of sites. The
prompt's own element is in the page, and a page can try to hide it, move it or paint over it: a press on
"Continue" counts only from a person, on a prompt that the browser reports fully in view and unaltered,
that is where Warden put it in the browser's top layer, and whose button has been in one place for a
moment. A page that fights the prompt can keep it from being answered; it cannot answer it.

Known and not fixed: a transaction handed to Backpack's `send()` without a fee payer or a blockhash, for
Backpack to fill in, cannot be read and is refused; and a message signed with a named second account at
Backpack's older door is asked about twice, once from each account's side.

Not built yet: token names beyond a handful of well-known ones (others show as a shortened mint address),
Firefox, mobile and agent policy. The icons are the Lamport mark on a light tile until there is a drawn one.
It has been run against the real wallets only as far as the prompt: no test has a funded wallet sign a real
transaction through it.
