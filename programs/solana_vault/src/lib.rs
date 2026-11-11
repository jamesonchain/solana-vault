use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("C1UkUmyqEpzqF9iQqB85TApksTuM7j3EB2WA8majpuRW");

// These seeds give every owner a separate state account and SOL vault.
const STATE_SEED: &[u8] = b"state";
const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod solana_vault {
    use super::*;

    // Create the owner's state PDA if needed, then put SOL in their vault PDA.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        ctx.accounts.state.owner = ctx.accounts.owner.key();

        let transfer_accounts = Transfer {
            from: ctx.accounts.owner.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };
        let transfer_context = CpiContext::new(system_program::ID, transfer_accounts);

        system_program::transfer(transfer_context, amount)
    }

    // Only the owner whose address derives this vault can withdraw its SOL.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            ctx.accounts.vault.lamports() >= amount,
            VaultError::InsufficientFunds
        );

        let owner_key = ctx.accounts.owner.key();
        let bump = [ctx.bumps.vault];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), &bump];
        let signer_seeds = &[vault_seeds];
        let transfer_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.owner.to_account_info(),
        };
        let transfer_context =
            CpiContext::new_with_signer(system_program::ID, transfer_accounts, signer_seeds);

        system_program::transfer(transfer_context, amount)
    }

    // Return every remaining vault lamport and close the state PDA to its owner.
    pub fn close(ctx: Context<Close>) -> Result<()> {
        let amount = ctx.accounts.vault.lamports();

        if amount > 0 {
            let owner_key = ctx.accounts.owner.key();
            let bump = [ctx.bumps.vault];
            let vault_seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), &bump];
            let signer_seeds = &[vault_seeds];
            let transfer_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner.to_account_info(),
            };
            let transfer_context =
                CpiContext::new_with_signer(system_program::ID, transfer_accounts, signer_seeds);

            system_program::transfer(transfer_context, amount)?;
        }

        Ok(())
    }
}

// Deposit initializes the state PDA once and uses the system-owned vault PDA.
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [STATE_SEED, owner.key().as_ref()],
        bump
    )]
    pub state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

// The state PDA checks ownership, and the vault PDA supplies signed withdrawals.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [STATE_SEED, owner.key().as_ref()],
        bump,
        has_one = owner
    )]
    pub state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

// Closing drains the vault and Anchor sends the state account's rent to owner.
#[derive(Accounts)]
pub struct Close<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [STATE_SEED, owner.key().as_ref()],
        bump,
        has_one = owner
    )]
    pub state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

// The state records the owner and is rent exempt until the close instruction.
#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub owner: Pubkey,
}

// These errors explain invalid amounts and withdrawals from an empty vault.
#[error_code]
pub enum VaultError {
    #[msg("The amount must be greater than zero")]
    ZeroAmount,
    #[msg("The vault does not have enough SOL")]
    InsufficientFunds,
}
