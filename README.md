# Solana Vault

This is a small Anchor program that lets an owner deposit SOL into a vault PDA, withdraw SOL, and close the vault. Each owner has a separate vault.

## Instructions

### Deposit

Deposit creates the owner's state account on first use and moves the requested SOL from the signer to that owner's vault PDA. Later deposits reuse the same accounts.

### Withdraw

Withdraw sends the requested amount from the vault to its owner. The owner must sign, and the program checks that the state and vault belong to that owner.

### Close

Close transfers all remaining SOL from the vault to its owner, then closes the state account so its rent is returned. The vault is a system account with no data, so it has no separate rent deposit.

## Build and tests

Install the JavaScript packages:

```text
npm install
```

Build the Anchor program:

```text
npm run build:program
```

Run the TypeScript LiteSVM tests:

```text
npm test
```

The test command builds the program before running the tests. The tests cover deposit, owner withdrawal, close, and a withdrawal attempt from another signer.

## What I learned

I learned that a PDA can hold SOL without having its own private key. The program can move SOL from the vault by signing with the PDA seeds.

I also learned that closing the state account returns its rent to the owner, and that a different signer should not be able to withdraw from someone else's vault.
