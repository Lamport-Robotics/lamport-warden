//! The shared rescuer set: who may create it, who may change it, and what it may hold.

use sentinel_program_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn only_the_upgrade_authority_creates_the_set_and_only_once() {
    let mut env = Env::new();
    let authority = env.funded();
    let admin = env.funded();
    let r = Keypair::new().pubkey();

    // a program with no upgrade authority has nobody who can
    let anyone = env.funded();
    expect_error(env.send(&[Env::ix_init_rescuer_set(&anyone.pubkey(), &anyone.pubkey(), &[r])], &[&anyone]), SentinelError::NotTheUpgradeAuthority);

    env.set_upgrade_authority(&authority.pubkey());
    expect_error(env.send(&[Env::ix_init_rescuer_set(&anyone.pubkey(), &anyone.pubkey(), &[r])], &[&anyone]), SentinelError::NotTheUpgradeAuthority);
    // another program's data account in the place of this one's
    let mut wrong = Env::ix_init_rescuer_set(&anyone.pubkey(), &anyone.pubkey(), &[r]);
    let lookalike = Keypair::new().pubkey();
    let mut data = env.svm.get_account(&program_data_address()).unwrap();
    data.data[13..45].copy_from_slice(anyone.pubkey().as_ref());
    env.svm.set_account(lookalike, data).unwrap();
    wrong.accounts[3] = solana_instruction::AccountMeta::new_readonly(lookalike, false);
    expect_error(env.send(&[wrong], &[&anyone]), SentinelError::NotTheUpgradeAuthority);

    ok(env.send(&[Env::ix_init_rescuer_set(&authority.pubkey(), &admin.pubkey(), &[r])], &[&authority]));
    assert!(env.send(&[Env::ix_init_rescuer_set(&authority.pubkey(), &authority.pubkey(), &[])], &[&authority]).is_err(), "it exists: it cannot be created again");
}

#[test]
fn only_the_admin_changes_the_set_and_it_holds_at_most_four_distinct_keys() {
    let mut env = Env::new();
    let keys: Vec<_> = (0..5).map(|_| Keypair::new().pubkey()).collect();
    let admin = env.rescuer_set(&keys[..1]);

    let stranger = env.funded();
    expect_error(env.send(&[Env::ix_update_rescuer_set(&stranger.pubkey(), None, &keys[..2])], &[&stranger]), SentinelError::NotTheAdmin);
    expect_error(env.send(&[Env::ix_update_rescuer_set(&stranger.pubkey(), Some(stranger.pubkey()), &keys[..1])], &[&stranger]), SentinelError::NotTheAdmin);

    ok(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &keys[..4])], &[&admin]));
    expect_error(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &keys[..5])], &[&admin]), SentinelError::TooManyRescuers);
    expect_error(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &[keys[0], keys[1], keys[0]])], &[&admin]), SentinelError::BadRescuer);
    expect_error(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &[solana_address::Address::default()])], &[&admin]), SentinelError::BadRescuer);
    expect_error(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), Some(solana_address::Address::default()), &keys[..1])], &[&admin]), SentinelError::BadRescuer);
    // an empty set is allowed: Lamport's service can be switched off for everyone at once
    ok(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &[])], &[&admin]));

    // handing the admin on: the old one is out
    let next = env.funded();
    ok(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), Some(next.pubkey()), &keys[..1])], &[&admin]));
    expect_error(env.send(&[Env::ix_update_rescuer_set(&admin.pubkey(), None, &keys[..2])], &[&admin]), SentinelError::NotTheAdmin);
    ok(env.send(&[Env::ix_update_rescuer_set(&next.pubkey(), None, &keys[..2])], &[&next]));
}

#[test]
fn an_owner_cannot_name_the_zero_key_as_their_rescuer_and_nobody_else_chooses_for_them() {
    let mut env = Env::new();
    let (owner, _) = env.owner_with_vault();
    expect_error(env.send(&[Env::ix_set_rescuers(&owner.pubkey(), Rescuers::Own(solana_address::Address::default()))], &[&owner]), SentinelError::BadRescuer);
    let stranger = env.funded();
    let mut forged = Env::ix_set_rescuers(&owner.pubkey(), Rescuers::Own(stranger.pubkey()));
    forged.accounts[0] = solana_instruction::AccountMeta::new_readonly(stranger.pubkey(), true);
    assert!(env.send(&[forged], &[&stranger]).is_err());
    ok(env.send(&[Env::ix_set_rescuers(&owner.pubkey(), Rescuers::Own(stranger.pubkey()))], &[&owner]));
    ok(env.send(&[Env::ix_set_rescuers(&owner.pubkey(), Rescuers::LamportSet)], &[&owner]));
}
