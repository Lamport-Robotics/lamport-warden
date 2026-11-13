# lamport-sentinel

The on-chain lock behind Warden Sentinel's rescue. Devnet only, not deployed, not audited.

An owner lets one address, the delegate, move their tokens. This program is the only thing that can sign as
that address, and the only thing it ever signs is a transfer into the associated token account of the
owner's own [Lamport Vault](https://github.com/Lamport-Robotics/lamport-vault). Whoever holds a rescuer key
can decide when an owner's tokens go to that owner's vault. They cannot decide where.

Lamport Vault is not changed and not called. The tokens land in a token account the vault owns, and the
vault spends from it with its own signature, as it does today.

Program id (devnet): `DHM2wm7S5Q4AzfzNFJV85tN3htUpYYEw38CdUApW6crK`

## Accounts

| | Address | Holds |
|---|---|---|
| `RescueConfig` | `["config", owner]` | the owner's vault, a proposed vault and when it may take effect, the delay, who may trigger a rescue |
| the delegate | `["delegate", owner, vault]` | nothing; it is the address the owner approves on each token account |
| `RescuerSet` | `["rescuers"]` | up to four keys of Lamport's rescue service, and the admin who may replace them |

## Instructions

| | Signer | What it does |
|---|---|---|
| `init_config(vault_change_delay?)` | owner | Creates the config for a live version-2 Lamport Vault. The delay is 72 hours unless given, 24 hours to 30 days, and fixed afterwards. |
| `propose_vault` | owner | Names a new vault. Rescues keep going to the current one. |
| `accept_vault` | owner | Switches to the proposed vault once the delay has passed. |
| `cancel_proposal` | owner | Drops the proposal. |
| `set_rescuers(LamportSet \| Own { key })` | owner | Lamport's set, or one key the owner runs. |
| `close_config` | owner | Removes the config and returns its rent. |
| `rescue_token` | owner, the owner's own rescuer, or a key of the set | Moves everything the delegate may move from one of the owner's token accounts into the vault's associated token account for that mint, creating it if missing (the signer pays the rent). Token and Token-2022. |
| `init_rescuer_set(admin, rescuers)` | the program's upgrade authority | Creates the shared set, once. |
| `update_rescuer_set(new_admin?, rescuers)` | the set's admin | Replaces the keys. No owner signs anything. |

The destination of a rescue is not an argument. It is derived in the program from the config's vault and the
mint.

A vault is accepted only if the account is owned by the Lamport Vault program (id pinned in the source),
carries the vault's discriminator and version 2, and sits at the address its own `vault_id` and bump derive.
A closed vault carries a tombstone and is refused, at `init_config`, `propose_vault`, `accept_vault` and at
every rescue.

## Where this differs from the spec, and why

**The delegate is bound to the vault.** The spec gives the delegate the seeds `["delegate", owner]`. With
those, the 72-hour delay on changing the vault can be walked around: `close_config` and `init_config` for
another vault, in one transaction, and every approval the owner ever gave now points at the new vault. One
phished signature would redirect a rescue.

Here the seeds are `["delegate", owner, vault]`. An approval is an approval to one vault. Changing the vault,
by proposal or by closing and starting again, carries nothing over: the owner approves each token account
again for the new vault. `tests/tests/config.rs` has the walk-around as a test.

What follows for the rest of Sentinel: Warden's recognition of the setup derives the delegate from the owner
and the vault named in the same transaction's `init_config`; and after an accepted vault change the wallet
shows as not armed until it is approved again.

**Two instructions the handoff does not list**, `init_rescuer_set` and `update_rescuer_set`. Without them
there is no "Lamport's set" for a config to point at.

**`accept_vault` needs the owner's signature.** The spec does not say who may call it. A proposal the owner
forgot should not become live because someone else pressed the button.

## Token-2022

Tested: a plain mint, and a mint with a transfer fee (the fee is held back in the vault's account, as on any
transfer). Refused by the token program, and so not rescued: a frozen account, a non-transferable mint, and a
mint with a transfer hook (the program passes the hook no accounts on purpose: a hook is someone else's code).
The arming page should list those three as not covered.

## Build and test

Needs Rust and Agave 2.3.13 (the version Lamport Vault pins). The program builds with platform-tools v1.56,
fetched on first build.

```sh
export COPYFILE_DISABLE=1   # macOS
cargo build-sbf --manifest-path programs/lamport-sentinel/Cargo.toml
cargo test -p sentinel-program-tests
```

The tests run the built program in LiteSVM. They build every instruction by hand, byte for byte, and do not
link the program's crate, so they check the compiled program against its written interface. Lamport Vault
accounts are written into the test chain in the vault's own layout; the vault program itself is not loaded,
because this program never calls it.

- `tests/tests/lock.rs`: a rescue lands in the vault's associated token account and nowhere else. A wrong
  destination, owner, delegate, mint, token program, a closed vault and a signer who is no rescuer are refused.
- `tests/tests/config.rs`: what may be a vault; the delay, one second early and at it; the close-and-reopen
  walk-around.
- `tests/tests/rescuers.rs`: who creates and changes the shared set.
- `tests/tests/vectors.rs`: `../vectors/instructions.json` is what this suite builds, and the compiled program
  accepts every instruction in it. Warden's own tests read that file (`UPDATE_VECTORS=1` rewrites it).
- `tests/tests/fuzz.rs`: 8,000 tampered calls (substituted accounts, random instruction bytes). After each,
  every token of the mint is the owner's or in the vault's associated token account.

Each check in the program was removed in turn and the tests run again: every removal fails tests, and with
the destination check gone the fuzz test finds a case that pays the thief.

## Not in this folder yet

No deployment, no IDL (that needs the Anchor CLI; the tests do not), no service, no arming page, no change to
the extension. The program keypair for the id above is not in the repo.
