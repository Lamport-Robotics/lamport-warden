//! `sentinel/vectors/instructions.json`: the setup and upkeep instructions for one fixed owner and vault, as
//! bytes. Two things are checked here: the file is exactly what this suite builds, and the compiled program
//! accepts every instruction in it. Warden's tests read the same file, so what Warden learns to recognise is
//! what the program really takes.
//!
//! `UPDATE_VECTORS=1 cargo test -p sentinel-program-tests --test vectors` rewrites the file.

use sentinel_program_tests::*;
use serde_json::{json, Map, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const AMOUNT: u64 = 2_500_000;
const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../vectors/instructions.json");

/// The owner Warden's own tests use: the keypair of seed 7,7,7,...
fn owner() -> Keypair {
    Keypair::new_from_array([7; 32])
}
fn mint_key() -> Keypair {
    Keypair::new_from_array([21; 32])
}
fn own_rescuer() -> Address {
    Keypair::new_from_array([11; 32]).pubkey()
}
const VAULT_ID: [u8; 32] = [9; 32];
const VAULT2_ID: [u8; 32] = [10; 32];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn to_json(ix: &Instruction) -> Value {
    json!({
        "programId": ix.program_id.to_string(),
        "accounts": ix.accounts.iter().map(|a| json!({ "pubkey": a.pubkey.to_string(), "isSigner": a.is_signer, "isWritable": a.is_writable })).collect::<Vec<_>>(),
        "data": hex(&ix.data),
    })
}

fn from_json(v: &Value) -> Instruction {
    let key = |s: &Value| s.as_str().unwrap().parse::<Address>().unwrap();
    let data = v["data"].as_str().unwrap();
    Instruction {
        program_id: key(&v["programId"]),
        accounts: v["accounts"].as_array().unwrap().iter().map(|a| AccountMeta { pubkey: key(&a["pubkey"]), is_signer: a["isSigner"].as_bool().unwrap(), is_writable: a["isWritable"].as_bool().unwrap() }).collect(),
        data: (0..data.len() / 2).map(|i| u8::from_str_radix(&data[2 * i..2 * i + 2], 16).unwrap()).collect(),
    }
}

fn build() -> Value {
    let o = owner().pubkey();
    let vault = Env::vault_address_of(&VAULT_ID);
    let vault2 = Env::vault_address_of(&VAULT2_ID);
    let mint = mint_key().pubkey();
    let source = ata(&o, &mint, &TOKEN);
    let mut ix = Map::new();
    ix.insert("init_config".into(), to_json(&Env::ix_init_config(&o, &vault, None)));
    ix.insert("init_config_with_delay_24h".into(), to_json(&Env::ix_init_config(&o, &vault, Some(24 * HOUR))));
    ix.insert("approve_checked".into(), to_json(&Env::ix_approve(&o, &source, &mint, TOKEN, &delegate_address(&o, &vault), u64::MAX, 6)));
    ix.insert("rescue_token_by_owner".into(), to_json(&Env::ix_rescue(&o, &o, &vault, &mint, TOKEN, false)));
    ix.insert("propose_vault".into(), to_json(&Env::ix_propose_vault(&o, &vault2)));
    ix.insert("accept_vault".into(), to_json(&Env::ix_accept_vault(&o, &vault2)));
    ix.insert("cancel_proposal".into(), to_json(&Env::ix_cancel_proposal(&o)));
    ix.insert("set_rescuers_own".into(), to_json(&Env::ix_set_rescuers(&o, Rescuers::Own(own_rescuer()))));
    ix.insert("set_rescuers_lamport_set".into(), to_json(&Env::ix_set_rescuers(&o, Rescuers::LamportSet)));
    ix.insert("close_config".into(), to_json(&Env::ix_close_config(&o)));
    json!({
        "about": "lamport-sentinel instructions for one fixed owner and vault. Written and checked by sentinel/program/tests/tests/vectors.rs, which also runs each through the compiled program. Warden's tests read this file.",
        "program": SENTINEL.to_string(),
        "lamportVaultProgram": LAMPORT_VAULT.to_string(),
        "owner": o.to_string(),
        "ownerSeed": "07".repeat(32),
        "vault": vault.to_string(),
        "vault2": vault2.to_string(),
        "config": config_address(&o).to_string(),
        "delegate": delegate_address(&o, &vault).to_string(),
        "delegate2": delegate_address(&o, &vault2).to_string(),
        "mint": mint.to_string(),
        "source": source.to_string(),
        "ownRescuer": own_rescuer().to_string(),
        "instructions": Value::Object(ix),
    })
}

fn stored() -> Value {
    serde_json::from_str(&std::fs::read_to_string(FILE).unwrap_or_else(|_| panic!("{FILE} is missing: run with UPDATE_VECTORS=1"))).expect("the vectors are JSON")
}

#[test]
fn the_file_is_what_this_suite_builds() {
    let built = build();
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(FILE).parent().unwrap()).unwrap();
        std::fs::write(FILE, serde_json::to_string_pretty(&built).unwrap() + "\n").unwrap();
    }
    assert_eq!(stored(), built, "sentinel/vectors/instructions.json is out of date: rerun with UPDATE_VECTORS=1 and look at the diff");
    assert_eq!(built["owner"], "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
}

#[test]
fn the_compiled_program_accepts_every_instruction_in_the_file() {
    let v = stored();
    let ix = |name: &str| from_json(&v["instructions"][name]);
    let mut env = Env::new();
    let owner = owner();
    let o = owner.pubkey();
    env.svm.airdrop(&o, 10 * SOL).unwrap();
    let vault = env.live_vault_with_id(&VAULT_ID);
    let vault2 = env.live_vault_with_id(&VAULT2_ID);
    assert_eq!(vault.to_string(), v["vault"]);
    let mint = env.mint_at(mint_key(), TOKEN, 6);
    let source = env.fund_tokens(&o, &mint, TOKEN, AMOUNT);

    // arming, exactly as the arming page will send it: init_config and the approval in one transaction
    ok(env.send(&[ix("init_config"), ix("approve_checked")], &[&owner]));
    let armed = env.token_account(&source).unwrap();
    assert_eq!((armed.delegate.map(|d| d.to_string()), armed.delegated_amount), (v["delegate"].as_str().map(String::from), u64::MAX));

    // the owner's own rescue lands in the vault
    ok(env.send(&[ix("rescue_token_by_owner")], &[&owner]));
    assert_eq!(env.holdings(&mint, TOKEN), vec![(vault, AMOUNT)]);

    ok(env.send(&[ix("set_rescuers_own")], &[&owner]));
    ok(env.send(&[ix("set_rescuers_lamport_set")], &[&owner]));

    env.set_time(1_800_000_000);
    ok(env.send(&[ix("propose_vault")], &[&owner]));
    ok(env.send(&[ix("cancel_proposal")], &[&owner]));
    ok(env.send(&[ix("propose_vault")], &[&owner]));
    expect_error(env.send(&[ix("accept_vault")], &[&owner]), SentinelError::TooEarly);
    env.set_time(1_800_000_000 + 72 * HOUR);
    ok(env.send(&[ix("accept_vault")], &[&owner]));
    let _ = vault2;

    ok(env.send(&[ix("close_config")], &[&owner]));
    // and the other form of init_config, on the config's address now free again
    ok(env.send(&[ix("init_config_with_delay_24h")], &[&owner]));
}
