//! The lock: whatever a caller passes, tokens the delegate may move end up in the associated token account
//! of the owner's configured vault, or they do not move.

use sentinel_program_tests::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

const AMOUNT: u64 = 1_000_000_000;

/// An armed owner, a rescuer key in the shared set, and the pieces of an honest rescue.
struct Armed {
    env: Env,
    owner: Keypair,
    vault: Address,
    rescuer: Keypair,
    mint: Address,
    source: Address,
    program: Address,
}

fn armed(program: Address) -> Armed {
    let mut env = Env::new();
    let rescuer = env.funded();
    env.rescuer_set(&[rescuer.pubkey()]);
    let (owner, vault) = env.owner_with_vault();
    let (mint, source) = env.armed_tokens(&owner, &vault, program, AMOUNT);
    Armed { env, owner, vault, rescuer, mint, source, program }
}

impl Armed {
    fn honest(&self) -> solana_instruction::Instruction {
        Env::ix_rescue(&self.rescuer.pubkey(), &self.owner.pubkey(), &self.vault, &self.mint, self.program, true)
    }
    fn vault_token(&self) -> Address {
        ata(&self.vault, &self.mint, &self.program)
    }
    /// Every token of the mint is still with the owner.
    #[track_caller]
    fn nothing_moved(&self) {
        assert_eq!(self.env.holdings(&self.mint, self.program), vec![(self.owner.pubkey(), AMOUNT)]);
    }
}

#[test]
fn a_rescuer_moves_the_whole_balance_into_the_vaults_token_account_and_nowhere_else() {
    for program in [TOKEN, TOKEN_2022] {
        let mut a = armed(program);
        assert!(a.env.token_account(&a.vault_token()).is_none(), "the vault has no account for this mint yet");
        let rescuer_sol = a.env.svm.get_balance(&a.rescuer.pubkey()).unwrap();
        let ix = a.honest();
        ok(a.env.send(&[ix], &[&a.rescuer]));

        let landed = a.env.token_account(&a.vault_token()).expect("the vault's token account was created");
        assert_eq!((landed.owner, landed.mint, landed.amount), (a.vault, a.mint, AMOUNT));
        assert_eq!(a.env.balance(&a.source), 0);
        assert_eq!(a.env.holdings(&a.mint, program), vec![(a.vault, AMOUNT)], "every token of the mint is the vault's");
        assert!(a.env.svm.get_balance(&a.rescuer.pubkey()).unwrap() < rescuer_sol, "the rescuer paid the new account's rent and the fee");

        // a second call has nothing to move
        let ix = a.honest();
        expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NothingToRescue);
    }
}

#[test]
fn the_owner_can_rescue_without_any_rescuer() {
    let mut a = armed(TOKEN);
    let ix = Env::ix_rescue(&a.owner.pubkey(), &a.owner.pubkey(), &a.vault, &a.mint, TOKEN, false);
    ok(a.env.send(&[ix], &[&a.owner]));
    assert_eq!(a.env.holdings(&a.mint, TOKEN), vec![(a.vault, AMOUNT)]);
}

#[test]
fn only_what_the_delegate_was_allowed_moves() {
    let mut a = armed(TOKEN);
    // the owner narrows the approval to a quarter
    let delegate = delegate_address(&a.owner.pubkey(), &a.vault);
    let owner = a.owner.insecure_clone();
    a.env.approve(&owner, &a.source, &a.mint, TOKEN, &delegate, AMOUNT / 4, 6);
    let ix = a.honest();
    ok(a.env.send(&[ix], &[&a.rescuer]));
    assert_eq!(a.env.balance(&a.vault_token()), AMOUNT / 4);
    assert_eq!(a.env.balance(&a.source), AMOUNT - AMOUNT / 4);
}

#[test]
fn a_wrong_destination_is_refused() {
    for program in [TOKEN, TOKEN_2022] {
        let mut a = armed(program);
        let thief = a.env.funded();
        let config = config_address(&a.owner.pubkey());
        let delegate = delegate_address(&a.owner.pubkey(), &a.vault);
        let set = Some(rescuer_set_address());
        let signer = a.rescuer.pubkey();

        // the rescuer's own token account for the mint, the thief's, and the owner's own source account
        let rescuers_own = a.env.fund_tokens(&signer, &a.mint, program, 0);
        let thiefs = a.env.fund_tokens(&thief.pubkey(), &a.mint, program, 0);
        for destination in [rescuers_own, thiefs, a.source] {
            let ix = Env::ix_rescue_raw(&signer, &config, &delegate, set, &a.vault, &a.mint, &a.source, &destination, program);
            let failed = a.env.send(&[ix], &[&a.rescuer]).expect_err("a destination that is not the vault's account must be refused");
            assert!(matches!(code(&failed), Some(anchor::ASSOCIATED) | Some(anchor::ASSOCIATED_OWNER)), "refused for another reason: {:?}\n{}", failed.err, failed.meta.logs.join("\n"));
        }

        // another live vault's token account: a real vault, but not this owner's
        let other_vault = a.env.live_vault();
        let other_vaults = a.env.fund_tokens(&other_vault, &a.mint, program, 0);
        let ix = Env::ix_rescue_raw(&signer, &config, &delegate, set, &a.vault, &a.mint, &a.source, &other_vaults, program);
        let failed = a.env.send(&[ix], &[&a.rescuer]).expect_err("another vault's account must be refused");
        assert!(matches!(code(&failed), Some(anchor::ASSOCIATED) | Some(anchor::ASSOCIATED_OWNER)), "{:?}", failed.err);

        // naming that other vault as the vault, with its real token account
        let ix = Env::ix_rescue_raw(&signer, &config, &delegate, set, &other_vault, &a.mint, &a.source, &other_vaults, program);
        expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotTheConfiguredVault);

        // a token account the vault does own, but not its associated one: the destination is one address, not "any account of the vault"
        let stray = a.env.stray_token_account(&a.vault.clone(), &a.mint.clone(), program);
        let ix = Env::ix_rescue_raw(&signer, &config, &delegate, set, &a.vault, &a.mint, &a.source, &stray, program);
        expect_code(a.env.send(&[ix], &[&a.rescuer]), anchor::NOT_ASSOCIATED);
        a.nothing_moved();
    }
}

#[test]
fn a_wrong_owner_is_refused() {
    let mut a = armed(TOKEN);
    // a second owner, armed for a vault of their own, with the same mint
    let (other, other_vault) = a.env.owner_with_vault();
    let others = a.env.fund_tokens(&other.pubkey(), &a.mint, TOKEN, 500);
    let other_delegate = delegate_address(&other.pubkey(), &other_vault);
    a.env.approve(&other, &others, &a.mint, TOKEN, &other_delegate, u64::MAX, 6);

    let signer = a.rescuer.pubkey();
    let set = Some(rescuer_set_address());
    // the first owner's config and vault, the second owner's tokens
    let ix = Env::ix_rescue_raw(&signer, &config_address(&a.owner.pubkey()), &delegate_address(&a.owner.pubkey(), &a.vault), set, &a.vault, &a.mint, &others, &a.vault_token(), TOKEN);
    expect_code(a.env.send(&[ix], &[&a.rescuer]), anchor::TOKEN_OWNER);
    // the second owner's config with the first owner's vault and delegate
    let ix = Env::ix_rescue_raw(&signer, &config_address(&other.pubkey()), &delegate_address(&a.owner.pubkey(), &a.vault), set, &a.vault, &a.mint, &a.source, &a.vault_token(), TOKEN);
    expect_code(a.env.send(&[ix], &[&a.rescuer]), anchor::SEEDS);
    // the second owner's config and delegate, the first owner's vault
    let ix = Env::ix_rescue_raw(&signer, &config_address(&other.pubkey()), &other_delegate, set, &a.vault, &a.mint, &others, &a.vault_token(), TOKEN);
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotTheConfiguredVault);

    assert_eq!(a.env.balance(&a.source), AMOUNT);
    assert_eq!(a.env.balance(&others), 500);
    assert_eq!(a.env.balance(&a.vault_token()), 0);
}

#[test]
fn a_wrong_delegate_is_refused() {
    let mut a = armed(TOKEN);
    let owner = a.owner.insecure_clone();
    let signer = a.rescuer.pubkey();

    // the owner later approved someone else: a token account has one delegate, so Sentinel's is gone
    let dapp = Keypair::new().pubkey();
    a.env.approve(&owner, &a.source, &a.mint, TOKEN, &dapp, u64::MAX, 6);
    let ix = a.honest();
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotArmed);

    // passing that other delegate in the delegate's place does not help: it is not this owner's and vault's
    let ix = Env::ix_rescue_raw(&signer, &config_address(&owner.pubkey()), &dapp, Some(rescuer_set_address()), &a.vault, &a.mint, &a.source, &a.vault_token(), TOKEN);
    expect_code(a.env.send(&[ix], &[&a.rescuer]), anchor::SEEDS);

    // approved for a different vault: the delegate of (owner, other vault) is another address
    let other_vault = a.env.live_vault();
    a.env.approve(&owner, &a.source, &a.mint, TOKEN, &delegate_address(&owner.pubkey(), &other_vault), u64::MAX, 6);
    let ix = a.honest();
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotArmed);

    // never approved at all
    let (mint2, _) = (a.env.mint(TOKEN, 6), ());
    a.env.fund_tokens(&owner.pubkey(), &mint2, TOKEN, 77);
    let ix = Env::ix_rescue(&signer, &owner.pubkey(), &a.vault, &mint2, TOKEN, true);
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotArmed);

    a.nothing_moved();
}

#[test]
fn a_closed_vault_is_refused() {
    let mut a = armed(TOKEN);
    a.env.close_vault(a.vault);
    let ix = a.honest();
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::VaultClosed);
    // also when the vault's token account already exists
    a.env.fund_tokens(&a.vault.clone(), &a.mint.clone(), TOKEN, 0);
    let ix = a.honest();
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::VaultClosed);
    a.nothing_moved();
}

#[test]
fn someone_who_is_not_a_rescuer_cannot_call_it() {
    let mut a = armed(TOKEN);
    let stranger = a.env.funded();
    for with_set in [true, false] {
        let ix = Env::ix_rescue(&stranger.pubkey(), &a.owner.pubkey(), &a.vault, &a.mint, TOKEN, with_set);
        expect_error(a.env.send(&[ix], &[&stranger]), SentinelError::NotARescuer);
    }
    // a key of the set that leaves the set out of the call is nobody
    let ix = Env::ix_rescue(&a.rescuer.pubkey(), &a.owner.pubkey(), &a.vault, &a.mint, TOKEN, false);
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotARescuer);
    // an account that only looks like the set
    let fake = Keypair::new().pubkey();
    let real = a.env.svm.get_account(&rescuer_set_address()).unwrap();
    a.env.svm.set_account(fake, real).unwrap();
    let ix = Env::ix_rescue_raw(&stranger.pubkey(), &config_address(&a.owner.pubkey()), &delegate_address(&a.owner.pubkey(), &a.vault), Some(fake), &a.vault, &a.mint, &a.source, &a.vault_token(), TOKEN);
    expect_code(a.env.send(&[ix], &[&stranger]), anchor::SEEDS);
    a.nothing_moved();
}

#[test]
fn an_owner_who_names_their_own_rescuer_shuts_lamports_out() {
    let mut a = armed(TOKEN);
    let own = a.env.funded();
    let owner = a.owner.insecure_clone();
    ok(a.env.send(&[Env::ix_set_rescuers(&owner.pubkey(), Rescuers::Own(own.pubkey()))], &[&owner]));

    let ix = a.honest();
    expect_error(a.env.send(&[ix], &[&a.rescuer]), SentinelError::NotARescuer);
    a.nothing_moved();

    let ix = Env::ix_rescue(&own.pubkey(), &owner.pubkey(), &a.vault, &a.mint, TOKEN, false);
    ok(a.env.send(&[ix], &[&own]));
    assert_eq!(a.env.holdings(&a.mint, TOKEN), vec![(a.vault, AMOUNT)], "the owner's own rescuer still only reaches the vault");
}

#[test]
fn a_rescuer_taken_out_of_the_set_can_no_longer_act() {
    let mut env = Env::new();
    let (old, new) = (env.funded(), env.funded());
    let admin = env.rescuer_set(&[old.pubkey()]);
    let (owner, vault) = env.owner_with_vault();
    let (mint, _) = env.armed_tokens(&owner, &vault, TOKEN, AMOUNT);
    ok(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &[new.pubkey()])], &[&admin]));

    let ix = Env::ix_rescue(&old.pubkey(), &owner.pubkey(), &vault, &mint, TOKEN, true);
    expect_error(env.send(&[ix], &[&old]), SentinelError::NotARescuer);
    // the new key works with no signature from the owner
    let ix = Env::ix_rescue(&new.pubkey(), &owner.pubkey(), &vault, &mint, TOKEN, true);
    ok(env.send(&[ix], &[&new]));
    assert_eq!(env.holdings(&mint, TOKEN), vec![(vault, AMOUNT)]);
}

#[test]
fn a_frozen_account_cannot_be_rescued_and_says_so_by_failing() {
    for program in [TOKEN, TOKEN_2022] {
        let mut a = armed(program);
        a.env.freeze(&a.source.clone(), &a.mint.clone(), program);
        let ix = a.honest();
        assert!(a.env.send(&[ix], &[&a.rescuer]).is_err(), "the token program refuses to move a frozen account");
        a.nothing_moved();
    }
}

#[test]
fn the_mint_and_the_token_program_must_be_the_accounts_own() {
    let mut a = armed(TOKEN);
    let signer = a.rescuer.pubkey();
    let config = config_address(&a.owner.pubkey());
    let delegate = delegate_address(&a.owner.pubkey(), &a.vault);
    let set = Some(rescuer_set_address());

    // another mint, with the vault's real account for that mint as the destination
    let other_mint = a.env.mint(TOKEN, 6);
    let ix = Env::ix_rescue_raw(&signer, &config, &delegate, set, &a.vault, &other_mint, &a.source, &ata(&a.vault, &other_mint, &TOKEN), TOKEN);
    expect_code(a.env.send(&[ix], &[&a.rescuer]), anchor::TOKEN_MINT);

    // the other token program
    let ix = Env::ix_rescue_raw(&signer, &config, &delegate, set, &a.vault, &a.mint, &a.source, &ata(&a.vault, &a.mint, &TOKEN_2022), TOKEN_2022);
    assert!(a.env.send(&[ix], &[&a.rescuer]).is_err());
    a.nothing_moved();
}

#[test]
fn token_2022_a_transfer_fee_is_taken_by_the_mint_and_the_rest_lands_in_the_vault() {
    let mut env = Env::new();
    let rescuer = env.funded();
    env.rescuer_set(&[rescuer.pubkey()]);
    let (owner, vault) = env.owner_with_vault();
    let mint = env.mint_2022_with_transfer_fee(6, 100, u64::MAX); // 1%
    let source = env.fund_tokens(&owner.pubkey(), &mint, TOKEN_2022, AMOUNT);
    env.approve(&owner, &source, &mint, TOKEN_2022, &delegate_address(&owner.pubkey(), &vault), u64::MAX, 6);

    let ix = Env::ix_rescue(&rescuer.pubkey(), &owner.pubkey(), &vault, &mint, TOKEN_2022, true);
    ok(env.send(&[ix], &[&rescuer]));
    assert_eq!(env.balance(&source), 0);
    // the fee is held back inside the vault's own account, for the mint's fee authority to collect
    assert_eq!(env.balance(&ata(&vault, &mint, &TOKEN_2022)), AMOUNT - AMOUNT / 100);
    assert_eq!(env.holdings(&mint, TOKEN_2022), vec![(vault, AMOUNT - AMOUNT / 100)], "nobody else holds any");
}

#[test]
fn token_2022_tokens_that_cannot_be_transferred_or_that_call_a_hook_are_not_rescued() {
    let mut env = Env::new();
    let rescuer = env.funded();
    env.rescuer_set(&[rescuer.pubkey()]);
    let (owner, vault) = env.owner_with_vault();
    let hook = Keypair::new().pubkey();
    for mint in [env.mint_2022_non_transferable(6), env.mint_2022_with_transfer_hook(6, &hook)] {
        let source = env.fund_tokens(&owner.pubkey(), &mint, TOKEN_2022, AMOUNT);
        env.approve(&owner, &source, &mint, TOKEN_2022, &delegate_address(&owner.pubkey(), &vault), u64::MAX, 6);
        let ix = Env::ix_rescue(&rescuer.pubkey(), &owner.pubkey(), &vault, &mint, TOKEN_2022, true);
        assert!(env.send(&[ix], &[&rescuer]).is_err(), "the token program refuses the transfer");
        assert_eq!(env.holdings(&mint, TOKEN_2022), vec![(owner.pubkey(), AMOUNT)]);
    }
}
