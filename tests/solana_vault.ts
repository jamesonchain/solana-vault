import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import {
  AccountRole,
  address,
  createClient,
  getAddressEncoder,
  getProgramDerivedAddress,
  generateKeyPairSigner,
  lamports,
} from "@solana/kit";
import type {
  Instruction,
  InstructionWithSigners,
  TransactionSigner,
} from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";

// These values match the program ID and PDA seeds in the Anchor program.
const PROGRAM_ADDRESS = address("C1UkUmyqEpzqF9iQqB85TApksTuM7j3EB2WA8majpuRW");
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const PROGRAM_PATH = "target/deploy/solana_vault.so";
const DEPOSIT_AMOUNT = 100_000_000n;
const SEED_STATE = new TextEncoder().encode("state");
const SEED_VAULT = new TextEncoder().encode("vault");

// Build the same Anchor instruction bytes used by the program's IDL.
function makeInstructionData(name: string, amount?: bigint): Uint8Array {
  const discriminator = createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);

  if (amount === undefined) {
    return discriminator;
  }

  const encodedAmount = Buffer.alloc(8);
  encodedAmount.writeBigUInt64LE(amount);
  return Buffer.concat([discriminator, encodedAmount]);
}

// Derive the state and SOL vault addresses for one owner.
async function deriveAddress(seed: Uint8Array, owner: string) {
  const [derivedAddress] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [seed, getAddressEncoder().encode(address(owner))],
  });

  return derivedAddress;
}

// Add the required accounts in the order declared by each Anchor instruction.
function makeVaultInstruction(
  name: "deposit" | "withdraw" | "close",
  owner: TransactionSigner,
  state: ReturnType<typeof address>,
  vault: ReturnType<typeof address>,
  amount?: bigint
): Omit<Instruction, "accounts"> & InstructionWithSigners {
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      {
        address: owner.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: owner,
      },
      {
        address: state,
        role:
          name === "deposit" || name === "close"
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      },
      { address: vault, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ] as const,
    data: makeInstructionData(name, amount),
  };
}

describe("SOL vault LiteSVM tests", () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;
  let stateAddress: ReturnType<typeof address>;
  let vaultAddress: ReturnType<typeof address>;

  // Start a fresh in process Solana VM and fund a temporary test signer.
  async function createTestClient() {
    return await createClient()
      .use(generatedSigner())
      .use(litesvm())
      .use(airdropSigner(lamports(2_000_000_000n)));
  }

  beforeEach(async () => {
    client = await createTestClient();
    client.svm.addProgramFromFile(PROGRAM_ADDRESS, PROGRAM_PATH);
    stateAddress = await deriveAddress(SEED_STATE, client.payer.address);
    vaultAddress = await deriveAddress(SEED_VAULT, client.payer.address);
  });

  // A deposit creates the state PDA and transfers SOL to the owner's vault.
  it("deposits SOL into the owner's PDA vault", async () => {
    await client.sendTransaction([
      makeVaultInstruction(
        "deposit",
        client.payer,
        stateAddress,
        vaultAddress,
        DEPOSIT_AMOUNT
      ),
    ]);

    assert.equal(client.svm.getBalance(vaultAddress), DEPOSIT_AMOUNT);
    assert.equal(typeof client.svm.getBalance(stateAddress), "bigint");
  });

  // A successful withdrawal reduces the vault by the requested amount.
  it("lets the owner withdraw SOL", async () => {
    await client.sendTransaction([
      makeVaultInstruction(
        "deposit",
        client.payer,
        stateAddress,
        vaultAddress,
        DEPOSIT_AMOUNT
      ),
    ]);
    await client.sendTransaction([
      makeVaultInstruction(
        "withdraw",
        client.payer,
        stateAddress,
        vaultAddress,
        40_000_000n
      ),
    ]);

    assert.equal(client.svm.getBalance(vaultAddress), 60_000_000n);
  });

  // Closing returns the SOL, removes both PDAs, and refunds the state rent.
  it("closes the vault and returns its rent", async () => {
    await client.sendTransaction([
      makeVaultInstruction(
        "deposit",
        client.payer,
        stateAddress,
        vaultAddress,
        DEPOSIT_AMOUNT
      ),
    ]);

    const ownerBalanceBeforeClose = client.svm.getBalance(client.payer.address);
    const vaultBalance = client.svm.getBalance(vaultAddress);
    assert.equal(vaultBalance, DEPOSIT_AMOUNT);
    if (ownerBalanceBeforeClose === null || vaultBalance === null) {
      throw new Error("The owner and vault must exist before close");
    }

    await client.sendTransaction([
      makeVaultInstruction("close", client.payer, stateAddress, vaultAddress),
    ]);

    assert.equal(client.svm.getBalance(vaultAddress), null);
    assert.equal(client.svm.getBalance(stateAddress), null);
    const ownerBalanceAfterClose = client.svm.getBalance(client.payer.address);
    if (ownerBalanceAfterClose === null) {
      throw new Error("The owner must exist after close");
    }
    assert.ok(ownerBalanceAfterClose > ownerBalanceBeforeClose + vaultBalance);
  });

  // A different signer must fail the owner's PDA checks when withdrawing.
  it("rejects a withdrawal signed by another person", async () => {
    await client.sendTransaction([
      makeVaultInstruction(
        "deposit",
        client.payer,
        stateAddress,
        vaultAddress,
        DEPOSIT_AMOUNT
      ),
    ]);

    const otherOwner = await generateKeyPairSigner();
    let withdrawalError: unknown;

    try {
      await client.sendTransaction([
        makeVaultInstruction(
          "withdraw",
          otherOwner,
          stateAddress,
          vaultAddress,
          1_000_000n
        ),
      ]);
    } catch (error) {
      withdrawalError = error;
    }

    assert.notEqual(withdrawalError, undefined);
    assert.match(String(withdrawalError), /0x7d6|2006|ConstraintSeeds/i);
    assert.equal(client.svm.getBalance(vaultAddress), DEPOSIT_AMOUNT);
  });
});
