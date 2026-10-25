import type { FinalTermsV1, SignedTermsV1 } from "@air-otc/shared-types";

export type DealStatus =
  | "MATCHED_AWAITING_BALANCE"
  | "FUNDED"
  | "DELIVERED"
  | "COMPLETED"
  | "AUTO_RELEASED"
  | "SELLER_TIMEOUT"
  | "CANCELLED";

export interface PrivateBalance {
  availableAtomic: string;
  lockedAtomic: string;
}

export interface ClaimedDeposit {
  accountId: string;
  amountAtomic: string;
  claimedAtNs: string;
}

export interface TermRound {
  round: number;
  status: "WAITING" | "NO_MATCH" | "MATCHED";
  buyer?: SignedTermsV1;
  seller?: SignedTermsV1;
  updatedAtNs: string;
}

export interface PrivateDeal {
  ticketId: string;
  termsHash: string;
  terms: FinalTermsV1;
  status: DealStatus;
  buyerLockedAtomic: string;
  sellerLockedAtomic: string;
  deliveryCommitment: string;
  buyerCancellation: boolean;
  sellerCancellation: boolean;
  fundedAtNs: string;
  deliveredAtNs: string;
  settledAtNs: string;
}

export interface PrivateWithdrawal {
  withdrawalId: string;
  accountId: string;
  recipientId: string;
  amountAtomic: string;
  expiryNs: string;
  ledgerRoot: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  createdAtNs: string;
  transactionHash: string;
}

export interface LedgerStateV1 {
  version: 1;
  revision: string;
  ledgerSequence: string;
  lastAnchoredSequence: string;
  lastAnchoredRoot: string;
  accounts: Record<string, PrivateBalance>;
  claimedDeposits: Record<string, ClaimedDeposit>;
  termRounds: Record<string, TermRound>;
  deals: Record<string, PrivateDeal>;
  usedNonces: Record<string, string>;
  withdrawals: Record<string, PrivateWithdrawal>;
}

export interface ContractDeposit {
  commitment: string;
  depositorId: string;
  amountAtomic: string;
  finalized: boolean;
}

export interface ContractWithdrawal {
  withdrawalId: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  attempts: number;
  transactionHash?: string;
}

export interface ContractGateway {
  getLedgerAnchor(): Promise<{ root: string; sequence: string }>;
  getDeposit(commitment: string, depositorId: string): Promise<ContractDeposit | null>;
  anchorLedgerRoot(root: string, sequence: string): Promise<{ transactionHash: string }>;
  withdraw(input: {
    withdrawalId: string;
    recipientId: string;
    amountAtomic: string;
    expiryNs: string;
    ledgerRoot: string;
  }): Promise<{ transactionHash: string }>;
  getWithdrawal(withdrawalId: string): Promise<ContractWithdrawal | null>;
}

export interface IdentityVerifier {
  isAuthorizedKey(accountId: string, publicKey: string): Promise<boolean>;
}

export interface Clock {
  nowNs(): bigint;
}

export interface StateStore {
  load(): Promise<LedgerStateV1 | null>;
  save(state: LedgerStateV1): Promise<void>;
}

export interface AttestationEvidence {
  version: 1;
  platform: "DSTACK_CVM" | "DEV_UNVERIFIED";
  reportData: string;
  attestationHex: string;
  appId: string;
  instanceId: string;
  composeHash: string;
  osImageHash: string;
  issuedAt: string;
}

export interface AttestationProvider {
  getEvidence(reportData: string): Promise<AttestationEvidence>;
}

