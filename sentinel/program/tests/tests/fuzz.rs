//! Thousands of malformed rescues. Whatever is put in any account's place, and whatever bytes are sent as the
//! instruction, the tokens of an armed owner are afterwards either still the owner's or in the vault's
//! associated token account, and none have gone missing.

use sentinel_program_tests::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const AMOUNT: u64 = 1_000_000;

/// xorshift64*: the same sequence on every run, so a failure can be found again by its number.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

struct World {
    env: Env,
    owner: Keypair,
    vault: Address,
    rescuer: Keypair,
    thief: Keypair,
    mint: Address,
    source: Address,
    /// How many of the mint's tokens exist. A rescue that goes through is followed by a fresh grant to the owner.
    total: u64,
    /// Everything a caller could put in an account's place.
    pool: Vec<Address>,
}

fn world() -> World {
    let mut env = Env::new();
    let rescuer = env.funded();
    env.rescuer_set(&[rescuer.pubkey()]);
    let (owner, vault) = env.owner_with_vault();
    let (mint, source) = env.armed_tokens(&owner, &vault, TOKEN, AMOUNT);
    let thief = env.funded();
    // the thief has a config and a vault of their own, and holds an (empty) account of the same mint
    let thiefs_vault = env.live_vault();
    ok(env.send(&[Env::ix_init_config(&thief.pubkey(), &thiefs_vault, None)], &[&thief]));
    let thiefs_tokens = env.fund_tokens(&thief.pubkey(), &mint, TOKEN, 0);
    env.approve(&thief, &thiefs_tokens, &mint, TOKEN, &delegate_address(&thief.pubkey(), &thiefs_vault), u64::MAX, 6);
    let thiefs_vault_tokens = env.fund_tokens(&thiefs_vault, &mint, TOKEN, 0);
    let other_mint = env.mint(TOKEN, 6);
    let stray = env.stray_token_account(&thief.pubkey(), &mint, TOKEN);
    let vaults_stray = env.stray_token_account(&vault, &mint, TOKEN);
    let closed = env.live_vault();
    env.close_vault(closed);
    let o = owner.pubkey();
    let pool = vec![
        o, vault, rescuer.pubkey(), thief.pubkey(), mint, other_mint, source, stray, vaults_stray, thiefs_tokens, thiefs_vault, thiefs_vault_tokens, closed,
        config_address(&o), config_address(&thief.pubkey()), delegate_address(&o, &vault), delegate_address(&thief.pubkey(), &thiefs_vault), delegate_address(&o, &thiefs_vault),
        rescuer_set_address(), ata(&vault, &mint, &TOKEN), ata(&vault, &other_mint, &TOKEN), ata(&thief.pubkey(), &other_mint, &TOKEN),
        SENTINEL, TOKEN, TOKEN_2022, ATA_PROGRAM, SYSTEM, LAMPORT_VAULT, Keypair::new().pubkey(),
    ];
    World { env, owner, vault, rescuer, thief, mint, source, total: AMOUNT, pool }
}

impl World {
    /// The mint's tokens are the owner's or the vault's, the vault's are in its associated token account, and they add up.
    #[track_caller]
    fn check(&self, case: u64) {
        let holdings = self.env.holdings(&self.mint, TOKEN);
        let sum: u64 = holdings.iter().map(|(_, n)| n).sum();
        assert_eq!(sum, self.total, "case {case}: tokens appeared or vanished: {holdings:?}");
        for (holder, amount) in &holdings {
            assert!(*holder == self.owner.pubkey() || *holder == self.vault, "case {case}: {amount} went to {holder}");
        }
        let in_vault = holdings.iter().find(|(h, _)| *h == self.vault).map_or(0, |(_, n)| *n);
        assert_eq!(self.env.balance(&ata(&self.vault, &self.mint, &TOKEN)), in_vault, "case {case}: the vault's share is not in its associated token account");
    }

    fn honest(&self, signer: &Address) -> Instruction {
        Env::ix_rescue(signer, &self.owner.pubkey(), &self.vault, &self.mint, TOKEN, true)
    }

    /// After a rescue went through: the owner gets tokens again and arms them, so the next case has something to steal.
    fn arm_again(&mut self) {
        assert_eq!(self.env.balance(&self.source), 0, "a rescue moves everything");
        let o = self.owner.pubkey();
        self.env.fund_tokens(&o, &self.mint.clone(), TOKEN, AMOUNT);
        self.total += AMOUNT;
        let owner = self.owner.insecure_clone();
        self.env.approve(&owner, &self.source.clone(), &self.mint.clone(), TOKEN, &delegate_address(&o, &self.vault), u64::MAX, 6);
    }
}

#[test]
fn no_substituted_account_sends_tokens_anywhere_but_the_vault() {
    let mut w = world();
    let mut rng = Rng(0x5EED_1234_ABCD_0001);
    let (mut went_through, mut refused) = (0u32, 0u32);
    for case in 0..4000u64 {
        // the thief signs, or the real rescuer does, with a tampered call
        let by_thief = rng.below(2) == 0;
        let signer = if by_thief { w.thief.insecure_clone() } else { w.rescuer.insecure_clone() };
        let mut ix = w.honest(&signer.pubkey());
        // replace one to three accounts (never the signer's own place) with something from the pool
        for _ in 0..1 + rng.below(3) {
            let slot = 1 + rng.below(ix.accounts.len() - 1);
            let with = w.pool[rng.below(w.pool.len())];
            ix.accounts[slot] = if ix.accounts[slot].is_writable { AccountMeta::new(with, false) } else { AccountMeta::new_readonly(with, false) };
        }
        let ok = w.env.send(&[ix], &[&signer]).is_ok();
        w.check(case);
        if ok {
            // only when every substitute was the account that belonged there anyway
            assert!(!by_thief, "case {case}: a key that is no rescuer of this owner triggered a rescue");
            went_through += 1;
            w.arm_again();
        } else {
            refused += 1;
        }
    }
    println!("substituted accounts: {refused} refused, {went_through} went through unchanged in effect");
    assert!(refused > 3500, "almost every tampered call is refused");
    assert!(went_through > 0, "and the cases do include calls that work, so the check is not empty");
}

#[test]
fn no_instruction_bytes_send_tokens_anywhere_but_the_vault() {
    let mut w = world();
    let mut rng = Rng(0x5EED_1234_ABCD_0002);
    let names = ["init_config", "propose_vault", "accept_vault", "cancel_proposal", "set_rescuers", "close_config", "rescue_token", "init_rescuer_set", "update_rescuer_set"];
    let (mut went_through, mut refused) = (0u32, 0u32);
    for case in 0..4000u64 {
        let by_thief = rng.below(2) == 0;
        let signer = if by_thief { w.thief.insecure_clone() } else { w.rescuer.insecure_clone() };
        let mut ix = w.honest(&signer.pubkey());
        // random bytes, or a real instruction's discriminator, cut short or followed by random bytes
        let mut data = if rng.below(3) == 0 { Vec::new() } else { discriminator(names[rng.below(names.len())]).to_vec() };
        if rng.below(4) == 0 { data.truncate(rng.below(9)); }
        for _ in 0..rng.below(80) { data.push(rng.next() as u8); }
        ix.data = data;
        let ok = w.env.send(&[ix], &[&signer]).is_ok();
        w.check(case);
        if ok {
            assert!(!by_thief, "case {case}: the thief's call went through");
            went_through += 1;
            w.arm_again();
        } else {
            refused += 1;
        }
    }
    println!("instruction bytes: {refused} refused, {went_through} were the rescuer's own rescue with bytes after it");
    assert!(went_through > 0 && refused > 3000);
}
