import {
  domainSeparatedHash,
  hashTerms,
  isSha256Hex,
  normalizeTerms,
  utf8,
} from "@air-otc/shared-types";
import type { DealStatus, LedgerStateV1, PrivateBalance } from "./types.js";

const MAX_U128 = (1n << 128n) - 1n;
const DEAL_STATUSES = new Set<DealStatus>([
  "MATCHED_AWAITING_BALANCE",
  "FUNDED",
  "DELIVERED",
  "COMPLETED",
  "AUTO_RELEASED",
  "SELLER_TIMEOUT",
  "CANCELLED",
]);

export function createEmptyState(): LedgerStateV1 {
  return {
    version: 1,
    revision: "0",
    ledgerSequence: "0",
    lastAnchoredSequence: "0",
    lastAnchoredRoot: "",
    accounts: {},
    claimedDeposits: {},
    termRounds: {},
    deals: {},
    usedNonces: {},
    withdrawals: {},
  };
}

export function validateState(value: unknown): LedgerStateV1 {
  const state = requireRecord(value, "ledger state") as unknown as LedgerStateV1;
  if (state.version !== 1) throw new Error("Unsupported ledger state version");
  for (const [name, field] of [
    ["revision", state.revision],
    ["ledgerSequence", state.ledgerSequence],
    ["lastAnchoredSequence", state.lastAnchoredSequence],
  ] as const) {
    requireUnsigned(field, name);
  }
  if (BigInt(state.lastAnchoredSequence) > BigInt(state.ledgerSequence)) {
    throw new Error("Anchored ledger sequence exceeds current sequence");
  }
  if (
    (state.lastAnchoredSequence === "0" && state.lastAnchoredRoot !== "") ||
    (state.lastAnchoredSequence !== "0" && !isSha256Hex(state.lastAnchoredRoot))
  ) {
    throw new Error("Anchored ledger root is inconsistent with its sequence");
  }

  const accounts = requireRecord(state.accounts, "accounts");
  const expectedLocked = new Map<string, bigint>();
  for (const [accountId, rawBalance] of Object.entries(accounts)) {
    requireAccountId(accountId);
    const balance = requireRecord(rawBalance, `balance for ${accountId}`);
    requireExactKeys(balance, ["availableAtomic", "lockedAtomic"], "balance");
    requireAtomic(balance.availableAtomic, "availableAtomic");
    requireAtomic(balance.lockedAtomic, "lockedAtomic");
  }

  const deals = requireRecord(state.deals, "deals");
  for (const [ticketId, rawDeal] of Object.entries(deals)) {
    const deal = requireRecord(rawDeal, `deal ${ticketId}`) as unknown as LedgerStateV1["deals"][string];
    if (deal.ticketId !== ticketId) throw new Error("Deal key does not match ticketId");
    const terms = normalizeTerms(deal.terms);
    if (terms.ticketId !== ticketId) throw new Error("Deal terms do not match ticketId");
    if (deal.termsHash !== hashTerms(terms)) throw new Error("Deal terms hash is invalid");
    if (!DEAL_STATUSES.has(deal.status)) throw new Error("Deal status is invalid");
    if (deal.buyerLockedAtomic !== addAtomic(terms.priceAtomic, terms.buyerCollateralAtomic)) {
      throw new Error("Buyer locked amount does not match terms");
    }
    if (deal.sellerLockedAtomic !== terms.sellerCollateralAtomic) {
      throw new Error("Seller locked amount does not match terms");
    }
    for (const timestamp of [deal.fundedAtNs, deal.deliveredAtNs, deal.settledAtNs]) {
      requireUnsigned(timestamp, "deal timestamp");
    }
    if (deal.deliveryCommitment !== "" && !isSha256Hex(deal.deliveryCommitment)) {
      throw new Error("Deal delivery commitment is invalid");
    }
    if (deal.status === "FUNDED" || deal.status === "DELIVERED") {
      addExpectedLock(expectedLocked, terms.buyerId, deal.buyerLockedAtomic);
      addExpectedLock(expectedLocked, terms.sellerId, deal.sellerLockedAtomic);
    }
  }
  for (const [accountId, amount] of expectedLocked) {
    const balance = Object.prototype.hasOwnProperty.call(accounts, accountId)
      ? (accounts[accountId] as PrivateBalance)
      : undefined;
    if (!balance || BigInt(balance.lockedAtomic) !== amount) {
      throw new Error("Account locked balance does not match active deals");
    }
  }
  for (const [accountId, rawBalance] of Object.entries(accounts)) {
    const balance = rawBalance as unknown as PrivateBalance;
    if (BigInt(balance.lockedAtomic) !== (expectedLocked.get(accountId) ?? 0n)) {
      throw new Error("Account has an unexplained locked balance");
    }
  }

  for (const [commitment, rawDeposit] of Object.entries(requireRecord(state.claimedDeposits, "claimedDeposits"))) {
    if (!isSha256Hex(commitment)) throw new Error("Claimed deposit commitment is invalid");
    const deposit = requireRecord(rawDeposit, "claimed deposit");
    requireAccountId(deposit.accountId);
    requireAtomic(deposit.amountAtomic, "claimed deposit amount");
    requireUnsigned(deposit.claimedAtNs, "claimed deposit timestamp");
  }
  requireRecord(state.termRounds, "termRounds");
  for (const timestamp of Object.values(requireRecord(state.usedNonces, "usedNonces"))) {
    requireUnsigned(timestamp, "nonce timestamp");
  }
  for (const [withdrawalId, rawWithdrawal] of Object.entries(requireRecord(state.withdrawals, "withdrawals"))) {
    if (!isSha256Hex(withdrawalId)) throw new Error("Withdrawal ID is invalid");
    const withdrawal = requireRecord(rawWithdrawal, "withdrawal");
    if (withdrawal.withdrawalId !== withdrawalId) throw new Error("Withdrawal key does not match ID");
    requireAccountId(withdrawal.accountId);
    requireAccountId(withdrawal.recipientId);
    requireAtomic(withdrawal.amountAtomic, "withdrawal amount", false);
    requireUnsigned(withdrawal.expiryNs, "withdrawal expiry");
    requireUnsigned(withdrawal.createdAtNs, "withdrawal timestamp");
    if (withdrawal.ledgerRoot !== "" && !isSha256Hex(withdrawal.ledgerRoot)) {
      throw new Error("Withdrawal ledger root is invalid");
    }
    if (!["PENDING", "COMPLETED", "FAILED"].includes(withdrawal.status as string)) {
      throw new Error("Withdrawal status is invalid");
    }
  }
  return state;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function ledgerRoot(state: LedgerStateV1): string {
  return domainSeparatedHash(
    "airotc:private-ledger:v1",
    utf8(
      stableJson({
        accounts: state.accounts,
        claimedDeposits: state.claimedDeposits,
        deals: state.deals,
      }),
    ),
  );
}

export function balanceFor(state: LedgerStateV1, accountId: string): PrivateBalance {
  if (Object.prototype.hasOwnProperty.call(state.accounts, accountId)) return state.accounts[accountId]!;
  const created: PrivateBalance = { availableAtomic: "0", lockedAtomic: "0" };
  state.accounts[accountId] = created;
  return created;
}

export function addAtomic(left: string, right: string): string {
  const result = requireAtomic(left, "left amount") + requireAtomic(right, "right amount");
  if (result > MAX_U128) throw new Error("Atomic amount overflow");
  return result.toString();
}

export function subtractAtomic(left: string, right: string, message = "Insufficient balance"): string {
  const result = requireAtomic(left, "left amount") - requireAtomic(right, "right amount");
  if (result < 0n) throw new Error(message);
  return result.toString();
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} contains missing or unsupported fields`);
  }
}

function requireUnsigned(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a canonical unsigned integer`);
  }
  return BigInt(value);
}

function requireAtomic(value: unknown, name: string, allowZero = true): bigint {
  const amount = requireUnsigned(value, name);
  if (!allowZero && amount === 0n) throw new Error(`${name} must be greater than zero`);
  if (amount > MAX_U128) throw new Error(`${name} exceeds u128`);
  return amount;
}

function requireAccountId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/.test(value)
  ) {
    throw new Error("Account ID is invalid");
  }
}

function addExpectedLock(locks: Map<string, bigint>, accountId: string, amount: string): void {
  locks.set(accountId, (locks.get(accountId) ?? 0n) + requireAtomic(amount, "locked amount"));
}
