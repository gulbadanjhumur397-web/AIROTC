import { base64UrlToBytes, utf8 } from "./encoding.js";
import { domainSeparatedHash } from "./hash.js";

export const DEPOSIT_COMMITMENT_DOMAIN = "airotc:deposit:v1";
export const DELIVERY_COMMITMENT_DOMAIN = "airotc:delivery:v1";

export function createDepositCommitment(secretBase64Url: string): string {
  const secret = base64UrlToBytes(secretBase64Url);
  if (secret.length !== 32) throw new Error("Deposit secret must be 32 bytes");
  return domainSeparatedHash(DEPOSIT_COMMITMENT_DOMAIN, secret);
}

export function createDeliveryCommitment(ciphertext: Uint8Array): string {
  if (ciphertext.length === 0) throw new Error("Delivery ciphertext cannot be empty");
  return domainSeparatedHash(DELIVERY_COMMITMENT_DOMAIN, ciphertext);
}

export function createWithdrawalId(workerId: string, sequence: string, ledgerRoot: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(sequence)) throw new Error("Withdrawal sequence must be an unsigned integer");
  if (!/^[0-9a-f]{64}$/.test(ledgerRoot)) throw new Error("Ledger root must be a SHA-256 hash");
  return domainSeparatedHash("airotc:withdrawal:v1", utf8(`${workerId}\0${sequence}\0${ledgerRoot}`));
}

