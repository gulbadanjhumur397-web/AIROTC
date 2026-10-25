import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { actionCreators } from "@near-js/transactions";
import { PublicKey } from "@near-js/crypto";
import { Buffer } from "buffer";

export interface NearWalletUi { selector: WalletSelector; modal: WalletSelectorModal }

export async function createNearWalletUi(contractId: string): Promise<NearWalletUi> {
  const selector = await setupWalletSelector({ network: "testnet", modules: [setupMyNearWallet()] });
  const modal = setupModal(selector, { contractId, description: "Connect a NEAR testnet wallet to use the private pool." });
  return { selector, modal };
}

export async function connectedAccount(selector: WalletSelector): Promise<string> {
  const accounts = selector.store.getState().accounts;
  return accounts.find((account) => account.active)?.accountId ?? accounts[0]?.accountId ?? "";
}

export async function authorizeSessionKey(selector: WalletSelector, accountId: string, publicKey: string, poolContractId: string): Promise<void> {
  const wallet = await selector.wallet();
  await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: accountId,
    actions: [actionCreators.addKey(
      PublicKey.fromString(publicKey),
      actionCreators.functionCallAccessKey(poolContractId, [], 250000000000000000000000n),
    )],
  });
}

export async function depositToPool(selector: WalletSelector, accountId: string, poolContractId: string, commitment: string, amountAtomic: string): Promise<void> {
  const wallet = await selector.wallet();
  await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: poolContractId,
    actions: [actionCreators.functionCall("deposit", { commitment }, 30_000_000_000_000n, BigInt(amountAtomic))],
  });
}

export async function signTokenChallenge(selector: WalletSelector, challenge: { message: string; nonce: string; recipient: string }): Promise<{ accountId: string; publicKey: string; signature: string }> {
  const wallet = await selector.wallet();
  if (!wallet.signMessage) throw new Error("This wallet cannot sign NEP-413 messages. Select a wallet with message signing support.");
  const signed = await wallet.signMessage({ message: challenge.message, nonce: Buffer.from(challenge.nonce, "base64"), recipient: challenge.recipient });
  if (!signed) throw new Error("Message signing was cancelled");
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
}
