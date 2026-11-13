//! What the tests in `tests/` share: a test chain with the built program, token mints and accounts made with
//! raw token instructions, Lamport Vault accounts written the way the vault program writes them, and every
//! lamport-sentinel instruction built by hand.
//!
//! The program is loaded from `target/deploy/lamport_sentinel.so`: run `cargo build-sbf` first.
//!
//! Nothing here uses the program's own crate. The instruction bytes and account lists are written out from
//! its source, so a test that passes says the compiled program does what its interface says.

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::{address, Address};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub const SENTINEL: Address = address!("DHM2wm7S5Q4AzfzNFJV85tN3htUpYYEw38CdUApW6crK");
pub const LAMPORT_VAULT: Address = address!("B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH");
pub const TOKEN: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Address = address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = address!("11111111111111111111111111111111");
pub const UPGRADEABLE_LOADER: Address = address!("BPFLoaderUpgradeab1e11111111111111111111111");

pub const HOUR: i64 = 3600;
pub const SOL: u64 = 1_000_000_000;

/// The program's own errors, in the order of `SentinelError`: Anchor numbers them from 6000.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SentinelError {
    NotAVault = 6000,
    VaultClosed,
    VaultVersion,
    BadDelay,
    SameVault,
    NoProposal,
    NotTheProposedVault,
    TooEarly,
    NotTheConfiguredVault,
    NotARescuer,
    NotArmed,
    NothingToRescue,
    TooManyRescuers,
    BadRescuer,
    NotTheUpgradeAuthority,
    NotTheAdmin,
}

/// Anchor's own errors that the tests name.
pub mod anchor {
    /// A `has_one` constraint: the account's stored key is not the one given.
    pub const HAS_ONE: u32 = 2001;
    /// A `seeds` constraint: the account is not at the derived address.
    pub const SEEDS: u32 = 2006;
    /// `token::mint`: the token account is for another mint.
    pub const TOKEN_MINT: u32 = 2014;
    /// `token::authority`: the token account belongs to someone else.
    pub const TOKEN_OWNER: u32 = 2015;
    /// The account is not the associated token account of that owner and mint.
    pub const ASSOCIATED: u32 = 2009;
    /// `associated_token::authority` on an existing account: its owner is someone else.
    pub const ASSOCIATED_OWNER: u32 = 2015;
    /// The account belongs to the right owner and mint but is not at the associated token account's address.
    pub const NOT_ASSOCIATED: u32 = 3014;
    /// The account does not hold what the program expected (wrong discriminator).
    pub const DISCRIMINATOR_MISMATCH: u32 = 3002;
    /// The account is owned by another program.
    pub const OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    /// The account was expected to be initialized and is not.
    pub const NOT_INITIALIZED: u32 = 3012;
    /// The instruction data did not match any instruction.
    pub const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;
    /// The instruction's arguments could not be read.
    pub const INSTRUCTION_DID_NOT_DESERIALIZE: u32 = 102;
}

/// The custom error code a failed transaction ended with, if that is how it failed.
pub fn code(failed: &FailedTransactionMetadata) -> Option<u32> {
    match &failed.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

/// Asserts the transaction failed with exactly this custom error.
#[track_caller]
pub fn expect_code(result: Result<TransactionMetadata, FailedTransactionMetadata>, want: u32) {
    match result {
        Ok(_) => panic!("expected error {want}, but the transaction succeeded"),
        Err(f) => assert_eq!(code(&f), Some(want), "wrong failure: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

/// Asserts the transaction failed with this lamport-sentinel error.
#[track_caller]
pub fn expect_error(result: Result<TransactionMetadata, FailedTransactionMetadata>, want: SentinelError) {
    expect_code(result, want as u32)
}

/// Asserts the transaction succeeded, printing its logs when it did not.
#[track_caller]
pub fn ok(result: Result<TransactionMetadata, FailedTransactionMetadata>) -> TransactionMetadata {
    match result {
        Ok(m) => m,
        Err(f) => panic!("expected success: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

/// Anchor's instruction discriminator: `sha256("global:<name>")[..8]`.
pub fn discriminator(name: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    out.copy_from_slice(&Sha256::digest(format!("global:{name}").as_bytes())[..8]);
    out
}

fn account_discriminator(name: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    out.copy_from_slice(&Sha256::digest(format!("account:{name}").as_bytes())[..8]);
    out
}

pub fn config_address(owner: &Address) -> Address {
    Address::find_program_address(&[b"config", owner.as_ref()], &SENTINEL).0
}

/// The address an owner approves on a token account so that it can be rescued into `vault`.
pub fn delegate_address(owner: &Address, vault: &Address) -> Address {
    Address::find_program_address(&[b"delegate", owner.as_ref(), vault.as_ref()], &SENTINEL).0
}

pub fn rescuer_set_address() -> Address {
    Address::find_program_address(&[b"rescuers"], &SENTINEL).0
}

pub fn program_data_address() -> Address {
    Address::find_program_address(&[SENTINEL.as_ref()], &UPGRADEABLE_LOADER).0
}

/// The associated token account of `wallet` for `mint` under `token_program`.
pub fn ata(wallet: &Address, mint: &Address, token_program: &Address) -> Address {
    Address::find_program_address(&[wallet.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// Who may trigger a rescue besides the owner: the argument of `set_rescuers`.
#[derive(Clone, Copy, Debug)]
pub enum Rescuers {
    LamportSet,
    Own(Address),
}

/// A token account as the token program stores it (the first 165 bytes are the same for Token and Token-2022).
#[derive(Debug, PartialEq, Eq)]
pub struct TokenAccount {
    pub mint: Address,
    pub owner: Address,
    pub amount: u64,
    pub delegate: Option<Address>,
    pub delegated_amount: u64,
}

pub struct Env {
    pub svm: LiteSVM,
    /// Pays for everything a test sets up; holds no role in the program.
    pub payer: Keypair,
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/lamport_sentinel.so");
        let bytes = std::fs::read(so).unwrap_or_else(|_| panic!("{so} is missing: run `cargo build-sbf --manifest-path programs/lamport-sentinel/Cargo.toml` first"));
        svm.add_program(SENTINEL, &bytes).expect("the program loads");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * SOL).expect("airdrop");
        Env { svm, payer }
    }

    /// A funded keypair.
    pub fn funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10 * SOL).expect("airdrop");
        k
    }

    /// Sends instructions in one transaction, paid by `signers[0]`.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        // a fresh blockhash each time, so that sending the same instructions twice is two transactions
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// Moves the chain's clock.
    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    // ── Lamport Vault accounts, written as the vault program writes them ──

    fn vault_address(vault_id: &[u8; 32]) -> (Address, u8) {
        Address::find_program_address(&[b"vault", vault_id], &LAMPORT_VAULT)
    }

    fn put(&mut self, address: Address, owner: Address, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).expect("set account");
    }

    /// The bytes of a live version-2 vault (lamport-vault `state.rs`): discriminator, version, bump, vault_id,
    /// LMS public key, spent, generation, created_slot, the used-leaf bitmap of a height-5 tree, no past keys.
    fn vault_bytes(version: u8, bump: u8, vault_id: &[u8; 32]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&[211, 8, 232, 43, 2, 152, 117, 119]);
        d.push(version);
        d.push(bump);
        d.extend_from_slice(vault_id);
        d.extend_from_slice(&[7u8; 56]);
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&1u64.to_le_bytes());
        d.extend_from_slice(&4u32.to_le_bytes());
        d.extend_from_slice(&[0u8; 4]);
        d.extend_from_slice(&0u32.to_le_bytes());
        d
    }

    /// A live vault at its own address.
    pub fn live_vault(&mut self) -> Address {
        self.live_vault_with_id(&Keypair::new().pubkey().to_bytes())
    }

    /// A live vault with a chosen `vault_id`, so that its address is the same on every run.
    pub fn live_vault_with_id(&mut self, vault_id: &[u8; 32]) -> Address {
        let (address, bump) = Self::vault_address(vault_id);
        self.put(address, LAMPORT_VAULT, Self::vault_bytes(2, bump, vault_id));
        address
    }

    /// The address of the vault with this `vault_id`.
    pub fn vault_address_of(vault_id: &[u8; 32]) -> Address {
        Self::vault_address(vault_id).0
    }

    /// Rewrites a vault as the tombstone `Close` leaves: its own discriminator, version 0xFE, vault_id, closed_slot, heir.
    pub fn close_vault(&mut self, vault: Address) {
        let old = self.svm.get_account(&vault).expect("the vault exists");
        let mut d = Vec::new();
        d.extend_from_slice(&[45, 187, 252, 155, 232, 114, 36, 22]);
        d.push(0xFE);
        d.extend_from_slice(&old.data[10..42]);
        d.extend_from_slice(&9u64.to_le_bytes());
        d.extend_from_slice(&Keypair::new().pubkey().to_bytes());
        self.put(vault, LAMPORT_VAULT, d);
    }

    /// A vault of another layout version.
    pub fn vault_of_version(&mut self, version: u8) -> Address {
        let vault_id = Keypair::new().pubkey().to_bytes();
        let (address, bump) = Self::vault_address(&vault_id);
        self.put(address, LAMPORT_VAULT, Self::vault_bytes(version, bump, &vault_id));
        address
    }

    /// Vault bytes that are right in every way, owned by another program.
    pub fn vault_lookalike_owned_by(&mut self, owner: Address) -> Address {
        let vault_id = Keypair::new().pubkey().to_bytes();
        let (address, bump) = Self::vault_address(&vault_id);
        self.put(address, owner, Self::vault_bytes(2, bump, &vault_id));
        address
    }

    /// Vault bytes owned by the vault program, at an address that is not the vault's own: what a staging
    /// buffer or any other account of the vault program would be if it could be made to carry these bytes.
    pub fn vault_bytes_at_another_address(&mut self) -> Address {
        let vault_id = Keypair::new().pubkey().to_bytes();
        let (_, bump) = Self::vault_address(&vault_id);
        let address = Keypair::new().pubkey();
        self.put(address, LAMPORT_VAULT, Self::vault_bytes(2, bump, &vault_id));
        address
    }

    /// An account of the vault program that is not a vault: a signature buffer's discriminator and some bytes.
    pub fn vault_program_account_that_is_not_a_vault(&mut self) -> Address {
        let address = Keypair::new().pubkey();
        let mut d = account_discriminator("SigBuffer").to_vec();
        d.extend_from_slice(&[1u8; 120]);
        self.put(address, LAMPORT_VAULT, d);
        address
    }

    // ── tokens, with raw token-program instructions (the same bytes for Token and Token-2022) ──

    /// A new mint with `decimals`; `self.payer` is its mint and freeze authority.
    pub fn mint(&mut self, token_program: Address, decimals: u8) -> Address {
        self.mint_at(Keypair::new(), token_program, decimals)
    }

    /// A mint at a chosen keypair's address.
    pub fn mint_at(&mut self, mint: Keypair, token_program: Address, decimals: u8) -> Address {
        let space = 82u64;
        let mut create = 0u32.to_le_bytes().to_vec();
        create.extend_from_slice(&self.svm.minimum_balance_for_rent_exemption(space as usize).to_le_bytes());
        create.extend_from_slice(&space.to_le_bytes());
        create.extend_from_slice(token_program.as_ref());
        let payer = self.payer.insecure_clone();
        let mut init = vec![20u8, decimals]; // InitializeMint2
        init.extend_from_slice(payer.pubkey().as_ref());
        init.push(1);
        init.extend_from_slice(payer.pubkey().as_ref());
        ok(self.send(
            &[
                Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(mint.pubkey(), true)], data: create },
                Instruction { program_id: token_program, accounts: vec![AccountMeta::new(mint.pubkey(), false)], data: init },
            ],
            &[&payer, &mint],
        ));
        mint.pubkey()
    }

    /// A Token-2022 mint with one extension, set up before the mint itself as the token program requires.
    /// `extension_len` is the extension's data length; `init` is its initialize instruction's data.
    pub fn mint_2022_with(&mut self, decimals: u8, extension_len: usize, init: Vec<u8>) -> Address {
        let mint = Keypair::new();
        // base mint (82) padded to an account's length (165), the account-type byte, then type, length and data
        let space = (165 + 1 + 4 + extension_len) as u64;
        let mut create = 0u32.to_le_bytes().to_vec();
        create.extend_from_slice(&self.svm.minimum_balance_for_rent_exemption(space as usize).to_le_bytes());
        create.extend_from_slice(&space.to_le_bytes());
        create.extend_from_slice(TOKEN_2022.as_ref());
        let payer = self.payer.insecure_clone();
        let mut init_mint = vec![20u8, decimals];
        init_mint.extend_from_slice(payer.pubkey().as_ref());
        init_mint.push(1);
        init_mint.extend_from_slice(payer.pubkey().as_ref());
        ok(self.send(
            &[
                Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(mint.pubkey(), true)], data: create },
                Instruction { program_id: TOKEN_2022, accounts: vec![AccountMeta::new(mint.pubkey(), false)], data: init },
                Instruction { program_id: TOKEN_2022, accounts: vec![AccountMeta::new(mint.pubkey(), false)], data: init_mint },
            ],
            &[&payer, &mint],
        ));
        mint.pubkey()
    }

    /// A Token-2022 mint that takes `basis_points` of every transfer, up to `maximum`.
    pub fn mint_2022_with_transfer_fee(&mut self, decimals: u8, basis_points: u16, maximum: u64) -> Address {
        let mut init = vec![26u8, 0, 0, 0]; // TransferFeeExtension, InitializeTransferFeeConfig, no authorities
        init.extend_from_slice(&basis_points.to_le_bytes());
        init.extend_from_slice(&maximum.to_le_bytes());
        self.mint_2022_with(decimals, 108, init)
    }

    /// A Token-2022 mint whose tokens can never be transferred.
    pub fn mint_2022_non_transferable(&mut self, decimals: u8) -> Address {
        self.mint_2022_with(decimals, 0, vec![32])
    }

    /// A Token-2022 mint that calls `hook_program` on every transfer.
    pub fn mint_2022_with_transfer_hook(&mut self, decimals: u8, hook_program: &Address) -> Address {
        let mut init = vec![36u8, 0]; // TransferHookExtension, Initialize
        init.extend_from_slice(&[0u8; 32]); // no authority
        init.extend_from_slice(hook_program.as_ref());
        self.mint_2022_with(decimals, 64, init)
    }

    /// A token account of `wallet` for `mint` that is not the associated one: at a fresh address.
    pub fn stray_token_account(&mut self, wallet: &Address, mint: &Address, token_program: Address) -> Address {
        let account = Keypair::new();
        let space = 165u64;
        let mut create = 0u32.to_le_bytes().to_vec();
        create.extend_from_slice(&self.svm.minimum_balance_for_rent_exemption(space as usize).to_le_bytes());
        create.extend_from_slice(&space.to_le_bytes());
        create.extend_from_slice(token_program.as_ref());
        let payer = self.payer.insecure_clone();
        let mut init = vec![18u8]; // InitializeAccount3
        init.extend_from_slice(wallet.as_ref());
        ok(self.send(
            &[
                Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(account.pubkey(), true)], data: create },
                Instruction { program_id: token_program, accounts: vec![AccountMeta::new(account.pubkey(), false), AccountMeta::new_readonly(*mint, false)], data: init },
            ],
            &[&payer, &account],
        ));
        account.pubkey()
    }

    /// Creates `wallet`'s associated token account for `mint` and puts `amount` in it.
    pub fn fund_tokens(&mut self, wallet: &Address, mint: &Address, token_program: Address, amount: u64) -> Address {
        let account = ata(wallet, mint, &token_program);
        let payer = self.payer.insecure_clone();
        let create = Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(account, false),
                AccountMeta::new_readonly(*wallet, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(token_program, false),
            ],
            data: vec![1], // CreateIdempotent
        };
        let mut data = vec![7u8]; // MintTo
        data.extend_from_slice(&amount.to_le_bytes());
        let mint_to = Instruction { program_id: token_program, accounts: vec![AccountMeta::new(*mint, false), AccountMeta::new(account, false), AccountMeta::new_readonly(payer.pubkey(), true)], data };
        ok(self.send(&[create, mint_to], &[&payer]));
        account
    }

    /// The `ApproveChecked` instruction: the owner lets `delegate` move up to `amount` out of `account`.
    pub fn ix_approve(owner: &Address, account: &Address, mint: &Address, token_program: Address, delegate: &Address, amount: u64, decimals: u8) -> Instruction {
        let mut data = vec![13u8];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);
        Instruction {
            program_id: token_program,
            accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false), AccountMeta::new_readonly(*delegate, false), AccountMeta::new_readonly(*owner, true)],
            data,
        }
    }

    /// `ApproveChecked`, sent.
    pub fn approve(&mut self, owner: &Keypair, account: &Address, mint: &Address, token_program: Address, delegate: &Address, amount: u64, decimals: u8) {
        let ix = Self::ix_approve(&owner.pubkey(), account, mint, token_program, delegate, amount, decimals);
        ok(self.send(&[ix], &[owner]));
    }

    /// `FreezeAccount`, by the mint's freeze authority.
    pub fn freeze(&mut self, account: &Address, mint: &Address, token_program: Address) {
        let payer = self.payer.insecure_clone();
        let ix = Instruction { program_id: token_program, accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false), AccountMeta::new_readonly(payer.pubkey(), true)], data: vec![10] };
        ok(self.send(&[ix], &[&payer]));
    }

    pub fn token_account(&self, address: &Address) -> Option<TokenAccount> {
        let a = self.svm.get_account(address)?;
        if a.data.len() < 165 || (a.owner != TOKEN && a.owner != TOKEN_2022) {
            return None;
        }
        let key = |at: usize| Address::new_from_array(a.data[at..at + 32].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(a.data[at..at + 8].try_into().unwrap());
        Some(TokenAccount {
            mint: key(0),
            owner: key(32),
            amount: u64_at(64),
            delegate: (u32::from_le_bytes(a.data[72..76].try_into().unwrap()) == 1).then(|| key(76)),
            delegated_amount: u64_at(121),
        })
    }

    pub fn balance(&self, address: &Address) -> u64 {
        self.token_account(address).map(|t| t.amount).unwrap_or(0)
    }

    /// The sum of every token account of `mint` that exists, by owner: where all of a mint's tokens are.
    pub fn holdings(&self, mint: &Address, token_program: Address) -> Vec<(Address, u64)> {
        let mut out: Vec<(Address, u64)> = Vec::new();
        for (address, _) in self.svm.get_program_accounts(&token_program) {
            if let Some(t) = self.token_account(&address) {
                if t.mint == *mint && t.amount > 0 {
                    match out.iter_mut().find(|(o, _)| *o == t.owner) {
                        Some(entry) => entry.1 += t.amount,
                        None => out.push((t.owner, t.amount)),
                    }
                }
            }
        }
        out.sort();
        out
    }

    // ── lamport-sentinel instructions, account lists in the order of the program's structs ──

    pub fn ix_init_config(owner: &Address, vault: &Address, delay: Option<i64>) -> Instruction {
        let mut data = discriminator("init_config").to_vec();
        match delay {
            None => data.push(0),
            Some(d) => {
                data.push(1);
                data.extend_from_slice(&d.to_le_bytes());
            }
        }
        Instruction {
            program_id: SENTINEL,
            accounts: vec![AccountMeta::new(*owner, true), AccountMeta::new(config_address(owner), false), AccountMeta::new_readonly(*vault, false), AccountMeta::new_readonly(SYSTEM, false)],
            data,
        }
    }

    fn ix_vault_change(name: &str, owner: &Address, new_vault: &Address) -> Instruction {
        Instruction {
            program_id: SENTINEL,
            accounts: vec![AccountMeta::new_readonly(*owner, true), AccountMeta::new(config_address(owner), false), AccountMeta::new_readonly(*new_vault, false)],
            data: discriminator(name).to_vec(),
        }
    }

    pub fn ix_propose_vault(owner: &Address, new_vault: &Address) -> Instruction {
        Self::ix_vault_change("propose_vault", owner, new_vault)
    }

    pub fn ix_accept_vault(owner: &Address, new_vault: &Address) -> Instruction {
        Self::ix_vault_change("accept_vault", owner, new_vault)
    }

    pub fn ix_cancel_proposal(owner: &Address) -> Instruction {
        Instruction { program_id: SENTINEL, accounts: vec![AccountMeta::new_readonly(*owner, true), AccountMeta::new(config_address(owner), false)], data: discriminator("cancel_proposal").to_vec() }
    }

    pub fn ix_set_rescuers(owner: &Address, rescuers: Rescuers) -> Instruction {
        let mut data = discriminator("set_rescuers").to_vec();
        match rescuers {
            Rescuers::LamportSet => data.push(0),
            Rescuers::Own(key) => {
                data.push(1);
                data.extend_from_slice(key.as_ref());
            }
        }
        Instruction { program_id: SENTINEL, accounts: vec![AccountMeta::new_readonly(*owner, true), AccountMeta::new(config_address(owner), false)], data }
    }

    pub fn ix_close_config(owner: &Address) -> Instruction {
        Instruction { program_id: SENTINEL, accounts: vec![AccountMeta::new(*owner, true), AccountMeta::new(config_address(owner), false)], data: discriminator("close_config").to_vec() }
    }

    /// `rescue_token` with every account named, so a test can put the wrong thing in any place.
    #[allow(clippy::too_many_arguments)]
    pub fn ix_rescue_raw(signer: &Address, config: &Address, delegate: &Address, rescuer_set: Option<Address>, vault: &Address, mint: &Address, source: &Address, destination: &Address, token_program: Address) -> Instruction {
        Instruction {
            program_id: SENTINEL,
            accounts: vec![
                AccountMeta::new(*signer, true),
                AccountMeta::new_readonly(*config, false),
                AccountMeta::new_readonly(*delegate, false),
                // Anchor reads the program's own id in an optional account's place as "not given"
                AccountMeta::new_readonly(rescuer_set.unwrap_or(SENTINEL), false),
                AccountMeta::new_readonly(*vault, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new(*source, false),
                AccountMeta::new(*destination, false),
                AccountMeta::new_readonly(token_program, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: discriminator("rescue_token").to_vec(),
        }
    }

    /// `rescue_token` as an honest caller builds it: everything derived from the owner, the vault and the mint.
    pub fn ix_rescue(signer: &Address, owner: &Address, vault: &Address, mint: &Address, token_program: Address, with_rescuer_set: bool) -> Instruction {
        Self::ix_rescue_raw(
            signer,
            &config_address(owner),
            &delegate_address(owner, vault),
            with_rescuer_set.then(rescuer_set_address),
            vault,
            mint,
            &ata(owner, mint, &token_program),
            &ata(vault, mint, &token_program),
            token_program,
        )
    }

    fn rescuer_list(data: &mut Vec<u8>, rescuers: &[Address]) {
        data.extend_from_slice(&(rescuers.len() as u32).to_le_bytes());
        for r in rescuers {
            data.extend_from_slice(r.as_ref());
        }
    }

    pub fn ix_init_rescuer_set(authority: &Address, admin: &Address, rescuers: &[Address]) -> Instruction {
        let mut data = discriminator("init_rescuer_set").to_vec();
        data.extend_from_slice(admin.as_ref());
        Self::rescuer_list(&mut data, rescuers);
        Instruction {
            program_id: SENTINEL,
            accounts: vec![
                AccountMeta::new(*authority, true),
                AccountMeta::new(rescuer_set_address(), false),
                AccountMeta::new_readonly(SENTINEL, false),
                AccountMeta::new_readonly(program_data_address(), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data,
        }
    }

    pub fn ix_update_rescuer_set(admin: &Address, new_admin: Option<Address>, rescuers: &[Address]) -> Instruction {
        let mut data = discriminator("update_rescuer_set").to_vec();
        match new_admin {
            None => data.push(0),
            Some(a) => {
                data.push(1);
                data.extend_from_slice(a.as_ref());
            }
        }
        Self::rescuer_list(&mut data, rescuers);
        Instruction { program_id: SENTINEL, accounts: vec![AccountMeta::new_readonly(*admin, true), AccountMeta::new(rescuer_set_address(), false)], data }
    }

    /// Names `authority` as the program's upgrade authority, as a real deploy would have one.
    pub fn set_upgrade_authority(&mut self, authority: &Address) {
        let address = program_data_address();
        let mut account = self.svm.get_account(&address).expect("the program's data account exists");
        // UpgradeableLoaderState::ProgramData: u32 variant 3, u64 slot, Option<Pubkey>
        assert_eq!(&account.data[..4], &3u32.to_le_bytes());
        account.data[12] = 1;
        account.data[13..45].copy_from_slice(authority.as_ref());
        self.svm.set_account(address, account).expect("set account");
    }

    /// Creates the shared rescuer set with these keys; returns its admin.
    pub fn rescuer_set(&mut self, rescuers: &[Address]) -> Keypair {
        let authority = self.funded();
        let admin = self.funded();
        self.set_upgrade_authority(&authority.pubkey());
        ok(self.send(&[Self::ix_init_rescuer_set(&authority.pubkey(), &admin.pubkey(), rescuers)], &[&authority]));
        admin
    }

    // ── a wallet armed the way the arming page arms one ──

    /// An owner with a config for a new live vault, the default delay, and Lamport's set as rescuers.
    pub fn owner_with_vault(&mut self) -> (Keypair, Address) {
        let owner = self.funded();
        let vault = self.live_vault();
        ok(self.send(&[Self::ix_init_config(&owner.pubkey(), &vault, None)], &[&owner]));
        (owner, vault)
    }

    /// Gives the owner `amount` of a new mint and approves the delegate for `vault` for all of it.
    pub fn armed_tokens(&mut self, owner: &Keypair, vault: &Address, token_program: Address, amount: u64) -> (Address, Address) {
        let mint = self.mint(token_program, 6);
        let account = self.fund_tokens(&owner.pubkey(), &mint, token_program, amount);
        self.approve(owner, &account, &mint, token_program, &delegate_address(&owner.pubkey(), vault), u64::MAX, 6);
        (mint, account)
    }
}
