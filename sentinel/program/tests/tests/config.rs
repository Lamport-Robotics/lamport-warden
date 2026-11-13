//! The config: what may be a vault, the delay on changing it, and what closing it leaves behind.

use sentinel_program_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const AMOUNT: u64 = 5_000_000;

#[test]
fn a_config_is_made_only_for_a_live_lamport_vault() {
    let mut env = Env::new();

    let owner = env.funded();
    let vault = env.live_vault();
    ok(env.send(&[Env::ix_init_config(&owner.pubkey(), &vault, None)], &[&owner]));
    // one per owner
    assert!(env.send(&[Env::ix_init_config(&owner.pubkey(), &vault, None)], &[&owner]).is_err());

    let refuse = |env: &mut Env, vault, want: SentinelError| {
        let owner = env.funded();
        expect_error(env.send(&[Env::ix_init_config(&owner.pubkey(), &vault, None)], &[&owner]), want);
        assert!(env.svm.get_account(&config_address(&owner.pubkey())).is_none(), "no config was left behind");
    };
    // a closed vault
    let closed = env.live_vault();
    env.close_vault(closed);
    refuse(&mut env, closed, SentinelError::VaultClosed);
    // a vault of a layout this program does not know
    let v1 = env.vault_of_version(1);
    refuse(&mut env, v1, SentinelError::VaultVersion);
    let v3 = env.vault_of_version(3);
    refuse(&mut env, v3, SentinelError::VaultVersion);
    // the right bytes under another program
    let fake = env.vault_lookalike_owned_by(TOKEN);
    refuse(&mut env, fake, SentinelError::NotAVault);
    // the right bytes under the vault program, at an address that is not that vault's
    let elsewhere = env.vault_bytes_at_another_address();
    refuse(&mut env, elsewhere, SentinelError::NotAVault);
    // another kind of account of the vault program
    let buffer = env.vault_program_account_that_is_not_a_vault();
    refuse(&mut env, buffer, SentinelError::NotAVault);
    // a wallet, and an account that does not exist
    let wallet = env.funded().pubkey();
    refuse(&mut env, wallet, SentinelError::NotAVault);
    refuse(&mut env, Keypair::new().pubkey(), SentinelError::NotAVault);
    // a token account the vault owns
    let mint = env.mint(TOKEN, 6);
    let vaults_tokens = env.fund_tokens(&vault, &mint, TOKEN, 1);
    refuse(&mut env, vaults_tokens, SentinelError::NotAVault);
}

#[test]
fn the_delay_is_72_hours_unless_chosen_and_never_under_24() {
    let mut env = Env::new();
    let vault = env.live_vault();
    for (delay, accepted) in [(Some(24 * HOUR - 1), false), (Some(0), false), (Some(-5), false), (Some(30 * 24 * HOUR + 1), false), (Some(i64::MAX), false), (Some(24 * HOUR), true), (Some(30 * 24 * HOUR), true), (None, true)] {
        let owner = env.funded();
        let result = env.send(&[Env::ix_init_config(&owner.pubkey(), &vault, delay)], &[&owner]);
        if accepted { ok(result); } else { expect_error(result, SentinelError::BadDelay); }
    }
}

#[test]
fn a_new_vault_cannot_be_accepted_one_second_early_and_can_be_at_the_delay() {
    for (delay, seconds) in [(None, 72 * HOUR), (Some(24 * HOUR), 24 * HOUR)] {
        let mut env = Env::new();
        let rescuer = env.funded();
        env.rescuer_set(&[rescuer.pubkey()]);
        let owner = env.funded();
        let old = env.live_vault();
        let new = env.live_vault();
        ok(env.send(&[Env::ix_init_config(&owner.pubkey(), &old, delay)], &[&owner]));
        let (mint, source) = env.armed_tokens(&owner, &old, TOKEN, AMOUNT);

        // nothing to accept yet
        expect_error(env.send(&[Env::ix_accept_vault(&owner.pubkey(), &new)], &[&owner]), SentinelError::NoProposal);
        let proposed_at = 1_800_000_000;
        env.set_time(proposed_at);
        ok(env.send(&[Env::ix_propose_vault(&owner.pubkey(), &new)], &[&owner]));

        // at once, and one second before the delay is over
        expect_error(env.send(&[Env::ix_accept_vault(&owner.pubkey(), &new)], &[&owner]), SentinelError::TooEarly);
        env.set_time(proposed_at + seconds - 1);
        expect_error(env.send(&[Env::ix_accept_vault(&owner.pubkey(), &new)], &[&owner]), SentinelError::TooEarly);

        // while it waits, a rescue still goes to the old vault, and the new one cannot be named
        let ix = Env::ix_rescue_raw(&rescuer.pubkey(), &config_address(&owner.pubkey()), &delegate_address(&owner.pubkey(), &new), Some(rescuer_set_address()), &new, &mint, &source, &ata(&new, &mint, &TOKEN), TOKEN);
        assert!(env.send(&[ix], &[&rescuer]).is_err());
        assert_eq!(env.holdings(&mint, TOKEN), vec![(owner.pubkey(), AMOUNT)]);

        // at the delay: only the proposed vault, only by the owner
        env.set_time(proposed_at + seconds);
        let third = env.live_vault();
        expect_error(env.send(&[Env::ix_accept_vault(&owner.pubkey(), &third)], &[&owner]), SentinelError::NotTheProposedVault);
        let stranger = env.funded();
        let mut forged = Env::ix_accept_vault(&owner.pubkey(), &new);
        forged.accounts[0] = solana_instruction::AccountMeta::new_readonly(stranger.pubkey(), true);
        assert!(env.send(&[forged], &[&stranger]).is_err());
        ok(env.send(&[Env::ix_accept_vault(&owner.pubkey(), &new)], &[&owner]));

        // the old approval named the old vault's delegate: it reaches neither vault now
        let ix = Env::ix_rescue(&rescuer.pubkey(), &owner.pubkey(), &new, &mint, TOKEN, true);
        expect_error(env.send(&[ix], &[&rescuer]), SentinelError::NotArmed);
        let ix = Env::ix_rescue(&rescuer.pubkey(), &owner.pubkey(), &old, &mint, TOKEN, true);
        assert!(env.send(&[ix], &[&rescuer]).is_err());
        assert_eq!(env.holdings(&mint, TOKEN), vec![(owner.pubkey(), AMOUNT)]);

        // approved again, for the new vault, the rescue lands there
        env.approve(&owner, &source, &mint, TOKEN, &delegate_address(&owner.pubkey(), &new), u64::MAX, 6);
        let ix = Env::ix_rescue(&rescuer.pubkey(), &owner.pubkey(), &new, &mint, TOKEN, true);
        ok(env.send(&[ix], &[&rescuer]));
        assert_eq!(env.holdings(&mint, TOKEN), vec![(new, AMOUNT)]);
    }
}

#[test]
fn a_proposal_can_be_cancelled_replaced_and_must_name_a_live_vault() {
    let mut env = Env::new();
    let (owner, vault) = env.owner_with_vault();
    let o = owner.pubkey();

    expect_error(env.send(&[Env::ix_cancel_proposal(&o)], &[&owner]), SentinelError::NoProposal);
    expect_error(env.send(&[Env::ix_propose_vault(&o, &vault)], &[&owner]), SentinelError::SameVault);
    let closed = env.live_vault();
    env.close_vault(closed);
    expect_error(env.send(&[Env::ix_propose_vault(&o, &closed)], &[&owner]), SentinelError::VaultClosed);
    let wallet = env.funded().pubkey();
    expect_error(env.send(&[Env::ix_propose_vault(&o, &wallet)], &[&owner]), SentinelError::NotAVault);

    // someone else cannot propose for this owner
    let stranger = env.funded();
    let new = env.live_vault();
    let mut forged = Env::ix_propose_vault(&o, &new);
    forged.accounts[0] = solana_instruction::AccountMeta::new_readonly(stranger.pubkey(), true);
    assert!(env.send(&[forged], &[&stranger]).is_err());

    env.set_time(1_800_000_000);
    ok(env.send(&[Env::ix_propose_vault(&o, &new)], &[&owner]));
    ok(env.send(&[Env::ix_cancel_proposal(&o)], &[&owner]));
    env.set_time(1_800_000_000 + 100 * HOUR);
    expect_error(env.send(&[Env::ix_accept_vault(&o, &new)], &[&owner]), SentinelError::NoProposal);

    // a second proposal replaces the first, and its own delay starts
    ok(env.send(&[Env::ix_propose_vault(&o, &new)], &[&owner]));
    let newer = env.live_vault();
    env.set_time(1_800_000_000 + 150 * HOUR);
    ok(env.send(&[Env::ix_propose_vault(&o, &newer)], &[&owner]));
    env.set_time(1_800_000_000 + 173 * HOUR);
    expect_error(env.send(&[Env::ix_accept_vault(&o, &new)], &[&owner]), SentinelError::NotTheProposedVault);
    expect_error(env.send(&[Env::ix_accept_vault(&o, &newer)], &[&owner]), SentinelError::TooEarly);

    // a proposed vault that was closed while it waited is not accepted
    env.close_vault(newer);
    env.set_time(1_800_000_000 + 300 * HOUR);
    expect_error(env.send(&[Env::ix_accept_vault(&o, &newer)], &[&owner]), SentinelError::VaultClosed);
}

#[test]
fn closing_the_config_and_making_another_does_not_carry_the_approvals_to_a_new_vault() {
    // The way round a delay: close the config and make a new one for another vault in the same transaction.
    // It works as far as the config goes. It moves nothing, because what the owner approved was the delegate
    // of the old vault.
    let mut env = Env::new();
    let rescuer = env.funded();
    env.rescuer_set(&[rescuer.pubkey()]);
    let (owner, old) = env.owner_with_vault();
    let (mint, source) = env.armed_tokens(&owner, &old, TOKEN, AMOUNT);
    let thiefs_vault = env.live_vault();

    let o = owner.pubkey();
    ok(env.send(&[Env::ix_close_config(&o), Env::ix_init_config(&o, &thiefs_vault, Some(24 * HOUR))], &[&owner]));

    let ix = Env::ix_rescue(&rescuer.pubkey(), &o, &thiefs_vault, &mint, TOKEN, true);
    expect_error(env.send(&[ix], &[&rescuer]), SentinelError::NotArmed);
    // nor by passing the old vault's delegate, which the token account does name
    let ix = Env::ix_rescue_raw(&rescuer.pubkey(), &config_address(&o), &delegate_address(&o, &old), Some(rescuer_set_address()), &thiefs_vault, &mint, &source, &ata(&thiefs_vault, &mint, &TOKEN), TOKEN);
    expect_code(env.send(&[ix], &[&rescuer]), anchor::SEEDS);
    // nor to the old vault, which the config no longer names
    let ix = Env::ix_rescue(&rescuer.pubkey(), &o, &old, &mint, TOKEN, true);
    assert!(env.send(&[ix], &[&rescuer]).is_err());
    assert_eq!(env.holdings(&mint, TOKEN), vec![(o, AMOUNT)]);
}

#[test]
fn closing_returns_the_rent_and_leaves_nothing_to_rescue_with() {
    let mut env = Env::new();
    let rescuer = env.funded();
    env.rescuer_set(&[rescuer.pubkey()]);
    let (owner, vault) = env.owner_with_vault();
    let (mint, _) = env.armed_tokens(&owner, &vault, TOKEN, AMOUNT);
    let o = owner.pubkey();

    let stranger = env.funded();
    let mut forged = Env::ix_close_config(&o);
    forged.accounts[0] = solana_instruction::AccountMeta::new(stranger.pubkey(), true);
    assert!(env.send(&[forged], &[&stranger]).is_err(), "only the owner closes their config");

    let before = env.svm.get_balance(&o).unwrap();
    ok(env.send(&[Env::ix_close_config(&o)], &[&owner]));
    assert!(env.svm.get_account(&config_address(&o)).map_or(true, |a| a.lamports == 0));
    assert!(env.svm.get_balance(&o).unwrap() > before, "the rent came back");

    // the approval is still on the token account; with no config nobody can use it, the owner included
    for signer in [&rescuer, &owner] {
        let ix = Env::ix_rescue(&signer.pubkey(), &o, &vault, &mint, TOKEN, true);
        assert!(env.send(&[ix], &[signer]).is_err());
    }
    assert_eq!(env.holdings(&mint, TOKEN), vec![(o, AMOUNT)]);
}
