//! # lamport-sentinel
//!
//! The lock behind Warden Sentinel's rescue. An owner lets one address, the
//! delegate, move their tokens. This program is the only thing that can sign as
//! that address, and the only thing it ever signs is a transfer into the
//! associated token account of the owner's own Lamport Vault. Whoever holds a
//! rescuer key can therefore decide *when* an owner's tokens go to that owner's
//! vault, and nothing else: not where, and not to whom.
//!
//! The delegate is bound to the vault, not only to the owner: its address is
//! `["delegate", owner, vault]`. An approval is thus an approval "to this vault".
//! Pointing the config at another vault (by `propose_vault` and `accept_vault`,
//! or by closing the config and making a new one) does not carry any approval
//! over: the owner has to approve again, per token account, for the new vault.
//! A single phished signature can never redirect tokens that are already armed.
//!
//! Lamport Vault itself is not changed and not called. Tokens are sent to a
//! token account the vault owns, which the vault spends with its own
//! hash-based signature.
//!
//! There is no fee, no pause and no admin over any owner's config. The one
//! shared account, [`RescuerSet`], lists the keys of Lamport's rescue service;
//! an owner may ignore it and name a key of their own.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("DHM2wm7S5Q4AzfzNFJV85tN3htUpYYEw38CdUApW6crK");

#[cfg(feature = "mainnet")]
compile_error!("there is no mainnet build of lamport-sentinel: Lamport Vault has no mainnet program id to pin, and neither program is audited");

/// The Lamport Vault program whose vaults may be a rescue destination. Devnet.
pub const LAMPORT_VAULT_PROGRAM_ID: Pubkey = pubkey!("B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH");

/// Seed prefix of [`RescueConfig`]: `["config", owner]`.
pub const CONFIG_SEED: &[u8] = b"config";
/// Seed prefix of the delegate address: `["delegate", owner, vault]`. No account lives there.
pub const DELEGATE_SEED: &[u8] = b"delegate";
/// Seed of the one [`RescuerSet`]: `["rescuers"]`.
pub const RESCUERS_SEED: &[u8] = b"rescuers";

/// How long a proposed vault waits before it can be accepted, unless the owner chose otherwise: 72 hours.
#[constant]
pub const DEFAULT_VAULT_CHANGE_DELAY: i64 = 72 * 3600;
/// The shortest delay an owner may choose: 24 hours.
#[constant]
pub const MIN_VAULT_CHANGE_DELAY: i64 = 24 * 3600;
/// The longest delay an owner may choose: 30 days.
#[constant]
pub const MAX_VAULT_CHANGE_DELAY: i64 = 30 * 24 * 3600;
/// Most keys in the shared rescuer set.
pub const MAX_RESCUERS: usize = 4;
/// Layout version of the accounts below.
pub const VERSION: u8 = 1;

// What a Lamport Vault looks like on chain (lamport-vault at c4a4ccd, programs/lamport-vault/src/state.rs).
// Checked by hand so this program does not link the vault's code.
/// `sha256("account:Vault")[..8]`.
const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
/// `sha256("account:Tombstone")[..8]`: what a closed vault leaves at its address.
const TOMBSTONE_DISCRIMINATOR: [u8; 8] = [45, 187, 252, 155, 232, 114, 36, 22];
/// The vault layout this program knows.
const VAULT_VERSION: u8 = 2;
/// Seed prefix of a vault's address: `["vault", vault_id]`.
const VAULT_SEED: &[u8] = b"vault";
/// discriminator, version, bump, vault_id: all this program reads.
const VAULT_HEAD_LEN: usize = 8 + 1 + 1 + 32;

/// Refuses anything that is not a live version-2 Lamport Vault at its own address.
///
/// Owned by the vault program, carrying the vault's discriminator (a closed
/// vault carries the tombstone's and is named as such), version 2, and sitting
/// at the address its own `vault_id` and bump derive. The last check means no
/// other account the vault program owns can stand in for a vault.
pub fn require_live_vault(vault: &AccountInfo) -> Result<()> {
    require_keys_eq!(*vault.owner, LAMPORT_VAULT_PROGRAM_ID, SentinelError::NotAVault);
    let data = vault.try_borrow_data()?;
    require!(data.len() >= VAULT_HEAD_LEN, SentinelError::NotAVault);
    require!(data[..8] != TOMBSTONE_DISCRIMINATOR, SentinelError::VaultClosed);
    require!(data[..8] == VAULT_DISCRIMINATOR, SentinelError::NotAVault);
    require!(data[8] == VAULT_VERSION, SentinelError::VaultVersion);
    let bump = data[9];
    let vault_id = &data[10..42];
    let expected = Pubkey::create_program_address(&[VAULT_SEED, vault_id, &[bump]], &LAMPORT_VAULT_PROGRAM_ID).map_err(|_| error!(SentinelError::NotAVault))?;
    require_keys_eq!(expected, vault.key(), SentinelError::NotAVault);
    Ok(())
}

/// At most [`MAX_RESCUERS`] keys, none of them the zero key, none twice.
fn require_valid_rescuers(rescuers: &[Pubkey]) -> Result<()> {
    require!(rescuers.len() <= MAX_RESCUERS, SentinelError::TooManyRescuers);
    for (i, r) in rescuers.iter().enumerate() {
        require_keys_neq!(*r, Pubkey::default(), SentinelError::BadRescuer);
        require!(!rescuers[..i].contains(r), SentinelError::BadRescuer);
    }
    Ok(())
}

#[program]
pub mod lamport_sentinel {
    use super::*;

    /// Creates the owner's config, pointing at their vault. `vault_change_delay`
    /// is how long a later change of vault must wait, in seconds; `None` is 72
    /// hours, and it is never under 24. It cannot be changed afterwards.
    pub fn init_config(ctx: Context<InitConfig>, vault_change_delay: Option<i64>) -> Result<()> {
        require_live_vault(&ctx.accounts.vault)?;
        let delay = vault_change_delay.unwrap_or(DEFAULT_VAULT_CHANGE_DELAY);
        require!((MIN_VAULT_CHANGE_DELAY..=MAX_VAULT_CHANGE_DELAY).contains(&delay), SentinelError::BadDelay);
        let config = &mut ctx.accounts.config;
        config.version = VERSION;
        config.bump = ctx.bumps.config;
        config.owner = ctx.accounts.owner.key();
        config.vault = ctx.accounts.vault.key();
        config.pending_vault = None;
        config.pending_effective_at = 0;
        config.vault_change_delay = delay;
        config.rescuers = Rescuers::LamportSet;
        config.created_at = Clock::get()?.unix_timestamp;
        emit!(ConfigCreated { owner: config.owner, vault: config.vault, vault_change_delay: delay });
        Ok(())
    }

    /// Names a new vault. It takes effect only through `accept_vault`, after the
    /// config's delay. Until then rescues go to the current vault. A second
    /// proposal replaces the first and starts the delay again.
    pub fn propose_vault(ctx: Context<ProposeVault>) -> Result<()> {
        require_live_vault(&ctx.accounts.new_vault)?;
        let config = &mut ctx.accounts.config;
        require_keys_neq!(ctx.accounts.new_vault.key(), config.vault, SentinelError::SameVault);
        let now = Clock::get()?.unix_timestamp;
        config.pending_vault = Some(ctx.accounts.new_vault.key());
        config.pending_effective_at = now.checked_add(config.vault_change_delay).ok_or(SentinelError::BadDelay)?;
        emit!(VaultProposed { owner: config.owner, current: config.vault, proposed: ctx.accounts.new_vault.key(), effective_at: config.pending_effective_at });
        Ok(())
    }

    /// Makes the proposed vault the config's vault, once its time has come. The
    /// delegate address changes with it, so nothing armed for the old vault can
    /// reach the new one: each token account is approved again for the new vault.
    pub fn accept_vault(ctx: Context<AcceptVault>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pending = config.pending_vault.ok_or(SentinelError::NoProposal)?;
        require_keys_eq!(ctx.accounts.new_vault.key(), pending, SentinelError::NotTheProposedVault);
        require!(Clock::get()?.unix_timestamp >= config.pending_effective_at, SentinelError::TooEarly);
        // it may have been closed while it waited
        require_live_vault(&ctx.accounts.new_vault)?;
        let previous = config.vault;
        config.vault = pending;
        config.pending_vault = None;
        config.pending_effective_at = 0;
        emit!(VaultAccepted { owner: config.owner, previous, vault: pending });
        Ok(())
    }

    /// Drops the proposed vault.
    pub fn cancel_proposal(ctx: Context<OwnerOnly>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let proposed = config.pending_vault.ok_or(SentinelError::NoProposal)?;
        config.pending_vault = None;
        config.pending_effective_at = 0;
        emit!(ProposalCancelled { owner: config.owner, proposed });
        Ok(())
    }

    /// Chooses who, besides the owner, may trigger a rescue: Lamport's set, or one key of the owner's own.
    pub fn set_rescuers(ctx: Context<OwnerOnly>, rescuers: Rescuers) -> Result<()> {
        if let Rescuers::Own { key } = rescuers {
            require_keys_neq!(key, Pubkey::default(), SentinelError::BadRescuer);
        }
        let config = &mut ctx.accounts.config;
        config.rescuers = rescuers;
        emit!(RescuersChosen { owner: config.owner, rescuers });
        Ok(())
    }

    /// Removes the config and returns its rent. Approvals already given stay on
    /// the token accounts until the owner revokes them, but with no config there
    /// is nothing that can use them; a new config for another vault cannot use
    /// them either, because they name the old vault's delegate.
    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        emit!(ConfigClosed { owner: ctx.accounts.config.owner, vault: ctx.accounts.config.vault });
        Ok(())
    }

    /// Moves everything the delegate is allowed to move out of `source` into the
    /// vault's associated token account for the same mint, creating that account
    /// if it is missing (the signer pays its rent). Token and Token-2022.
    ///
    /// The signer is the owner, the owner's own rescuer key, or a key of the
    /// shared set, as the config says. The destination is not an argument: it is
    /// derived here from the config's vault and the mint.
    pub fn rescue_token(ctx: Context<RescueToken>) -> Result<()> {
        let config = &ctx.accounts.config;
        let signer = ctx.accounts.rescuer.key();
        let allowed = signer == config.owner
            || match config.rescuers {
                Rescuers::Own { key } => signer == key,
                Rescuers::LamportSet => ctx.accounts.rescuer_set.as_ref().is_some_and(|set| set.rescuers.contains(&signer)),
            };
        require!(allowed, SentinelError::NotARescuer);
        // a vault closed since the config was made must not be sent anything
        require_live_vault(&ctx.accounts.vault)?;

        let source = &ctx.accounts.source;
        require!(source.delegate == COption::Some(ctx.accounts.delegate.key()), SentinelError::NotArmed);
        let amount = source.amount.min(source.delegated_amount);
        require!(amount > 0, SentinelError::NothingToRescue);

        let owner = config.owner;
        let vault = config.vault;
        let seeds: &[&[u8]] = &[DELEGATE_SEED, owner.as_ref(), vault.as_ref(), &[ctx.bumps.delegate]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.delegate.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(Rescued { owner, vault, mint: ctx.accounts.mint.key(), source: ctx.accounts.source.key(), destination: ctx.accounts.vault_token.key(), amount, rescuer: signer });
        Ok(())
    }

    /// Creates the shared rescuer set. Only the program's upgrade authority can,
    /// so nobody can get there first after a deploy.
    pub fn init_rescuer_set(ctx: Context<InitRescuerSet>, admin: Pubkey, rescuers: Vec<Pubkey>) -> Result<()> {
        require_keys_neq!(admin, Pubkey::default(), SentinelError::BadRescuer);
        require_valid_rescuers(&rescuers)?;
        let set = &mut ctx.accounts.rescuer_set;
        set.version = VERSION;
        set.bump = ctx.bumps.rescuer_set;
        set.admin = admin;
        set.rescuers = rescuers.clone();
        emit!(RescuerSetChanged { admin, rescuers });
        Ok(())
    }

    /// Replaces the rescuer keys, and the admin if a new one is given. The admin
    /// signs. No owner signs anything: their approvals name the delegate, not a rescuer.
    pub fn update_rescuer_set(ctx: Context<UpdateRescuerSet>, new_admin: Option<Pubkey>, rescuers: Vec<Pubkey>) -> Result<()> {
        require_valid_rescuers(&rescuers)?;
        let set = &mut ctx.accounts.rescuer_set;
        if let Some(admin) = new_admin {
            require_keys_neq!(admin, Pubkey::default(), SentinelError::BadRescuer);
            set.admin = admin;
        }
        set.rescuers = rescuers.clone();
        emit!(RescuerSetChanged { admin: set.admin, rescuers });
        Ok(())
    }
}

/// Who, besides the owner, may trigger a rescue for a config.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Rescuers {
    /// The keys in the shared [`RescuerSet`]: Lamport's rescue service.
    LamportSet,
    /// One key the owner runs themselves. Lamport's service can then only alert.
    Own {
        /// The owner's rescuer key.
        key: Pubkey,
    },
}

/// One per owner. PDA `["config", owner]`.
#[account]
#[derive(InitSpace)]
pub struct RescueConfig {
    /// Layout version, [`VERSION`].
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// The wallet whose tokens may be rescued.
    pub owner: Pubkey,
    /// The Lamport Vault rescued tokens go to.
    pub vault: Pubkey,
    /// A vault proposed to replace it, if any.
    pub pending_vault: Option<Pubkey>,
    /// Unix time from which `accept_vault` works; 0 with no proposal.
    pub pending_effective_at: i64,
    /// Seconds a proposal must wait. Fixed when the config is made.
    pub vault_change_delay: i64,
    /// Who may trigger a rescue besides the owner.
    pub rescuers: Rescuers,
    /// Unix time of creation.
    pub created_at: i64,
}

/// The keys of Lamport's rescue service. PDA `["rescuers"]`, one for the program.
#[account]
#[derive(InitSpace)]
pub struct RescuerSet {
    /// Layout version, [`VERSION`].
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// Who may replace the keys: a Lamport multisig.
    pub admin: Pubkey,
    /// The rescuer keys.
    #[max_len(MAX_RESCUERS)]
    pub rescuers: Vec<Pubkey>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + RescueConfig::INIT_SPACE, seeds = [CONFIG_SEED, owner.key().as_ref()], bump)]
    pub config: Account<'info, RescueConfig>,
    /// CHECK: `require_live_vault` checks its owner, layout, version and address.
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeVault<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [CONFIG_SEED, owner.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, RescueConfig>,
    /// CHECK: `require_live_vault` checks its owner, layout, version and address.
    pub new_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptVault<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [CONFIG_SEED, owner.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, RescueConfig>,
    /// CHECK: must be the proposed vault, and `require_live_vault` checks it again.
    pub new_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [CONFIG_SEED, owner.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, RescueConfig>,
}

#[derive(Accounts)]
pub struct CloseConfig<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, has_one = owner, seeds = [CONFIG_SEED, owner.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, RescueConfig>,
}

#[derive(Accounts)]
pub struct RescueToken<'info> {
    /// The owner, the owner's own rescuer key, or a key of the shared set. Pays the rent of a new vault token account.
    #[account(mut)]
    pub rescuer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, config.owner.as_ref()], bump = config.bump)]
    pub config: Account<'info, RescueConfig>,
    /// CHECK: the delegate address for this owner and this vault. It holds nothing; the program signs as it.
    #[account(seeds = [DELEGATE_SEED, config.owner.as_ref(), config.vault.as_ref()], bump)]
    pub delegate: UncheckedAccount<'info>,
    /// The shared set. Needed only when the signer is one of its keys.
    #[account(seeds = [RESCUERS_SEED], bump = rescuer_set.bump)]
    pub rescuer_set: Option<Account<'info, RescuerSet>>,
    /// CHECK: the config's vault, and `require_live_vault` checks it is still one.
    #[account(address = config.vault @ SentinelError::NotTheConfiguredVault)]
    pub vault: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// The owner's token account to empty.
    #[account(mut, token::mint = mint, token::authority = config.owner, token::token_program = token_program)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    /// The vault's associated token account for this mint: the only place the tokens can go.
    #[account(init_if_needed, payer = rescuer, associated_token::mint = mint, associated_token::authority = vault, associated_token::token_program = token_program)]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitRescuerSet<'info> {
    /// The program's upgrade authority.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + RescuerSet::INIT_SPACE, seeds = [RESCUERS_SEED], bump)]
    pub rescuer_set: Account<'info, RescuerSet>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SentinelError::NotTheUpgradeAuthority)]
    pub program: Program<'info, crate::program::LamportSentinel>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ SentinelError::NotTheUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRescuerSet<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ SentinelError::NotTheAdmin, seeds = [RESCUERS_SEED], bump = rescuer_set.bump)]
    pub rescuer_set: Account<'info, RescuerSet>,
}

#[event]
pub struct ConfigCreated {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub vault_change_delay: i64,
}

#[event]
pub struct VaultProposed {
    pub owner: Pubkey,
    pub current: Pubkey,
    pub proposed: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct VaultAccepted {
    pub owner: Pubkey,
    pub previous: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct ProposalCancelled {
    pub owner: Pubkey,
    pub proposed: Pubkey,
}

#[event]
pub struct RescuersChosen {
    pub owner: Pubkey,
    pub rescuers: Rescuers,
}

#[event]
pub struct ConfigClosed {
    pub owner: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct Rescued {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub rescuer: Pubkey,
}

#[event]
pub struct RescuerSetChanged {
    pub admin: Pubkey,
    pub rescuers: Vec<Pubkey>,
}

#[error_code]
pub enum SentinelError {
    #[msg("That account is not a Lamport Vault")]
    NotAVault,
    #[msg("That vault is closed")]
    VaultClosed,
    #[msg("That vault's layout version is not one this program knows")]
    VaultVersion,
    #[msg("The delay must be between 24 hours and 30 days")]
    BadDelay,
    #[msg("That is already the config's vault")]
    SameVault,
    #[msg("There is no proposed vault")]
    NoProposal,
    #[msg("That is not the proposed vault")]
    NotTheProposedVault,
    #[msg("The proposed vault cannot be accepted yet")]
    TooEarly,
    #[msg("That is not the config's vault")]
    NotTheConfiguredVault,
    #[msg("The signer may not trigger a rescue for this owner")]
    NotARescuer,
    #[msg("That token account has not approved this owner's delegate for this vault")]
    NotArmed,
    #[msg("There is nothing the delegate may move from that token account")]
    NothingToRescue,
    #[msg("A rescuer set holds at most four keys")]
    TooManyRescuers,
    #[msg("A rescuer key is the zero key or is listed twice")]
    BadRescuer,
    #[msg("Only the program's upgrade authority can create the rescuer set")]
    NotTheUpgradeAuthority,
    #[msg("Only the rescuer set's admin can change it")]
    NotTheAdmin,
}
