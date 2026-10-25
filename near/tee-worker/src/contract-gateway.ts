import type { ContractDeposit, ContractGateway, ContractWithdrawal } from "./types.js";

interface NearGatewayConfig {
  networkId: string;
  rpcUrl: string;
  accountId: string;
  privateKey: string;
  contractId: string;
}

const WORKER_METHODS = ["anchor_ledger_root", "withdraw"] as const;

interface AccessKeyProvider {
  viewAccessKey(input: { accountId: string; publicKey: string }): Promise<{
    permission:
      | "FullAccess"
      | { FunctionCall: { receiver_id: string; method_names: string[]; allowance?: string | null } };
  }>;
  viewAccessKeyList(input: { accountId: string }): Promise<{
    keys: Array<{ public_key: string }>;
  }>;
}

export async function assertRestrictedWorkerAccessKey(
  provider: AccessKeyProvider,
  accountId: string,
  publicKey: string,
  contractId: string,
): Promise<void> {
  const keyList = await provider.viewAccessKeyList({ accountId });
  if (keyList.keys.length !== 1 || keyList.keys[0]?.public_key !== publicKey) {
    throw new Error("TEE worker account must contain only the provisioned restricted key");
  }
  const accessKey = await provider.viewAccessKey({ accountId, publicKey });
  if (accessKey.permission === "FullAccess") {
    throw new Error("TEE worker key must not have FullAccess permission");
  }
  const permission = accessKey.permission.FunctionCall;
  if (permission.receiver_id !== contractId) {
    throw new Error("TEE worker key receiver does not match the pool contract");
  }
  const methods = [...permission.method_names].sort();
  const required = [...WORKER_METHODS].sort();
  if (methods.length !== required.length || methods.some((method, index) => method !== required[index])) {
    throw new Error("TEE worker key must be restricted to anchor_ledger_root and withdraw");
  }
}

export class NearContractGateway implements ContractGateway {
  private constructor(
    private readonly account: import("near-api-js").Account,
    private readonly provider: import("near-api-js").JsonRpcProvider,
    private readonly contractId: string,
  ) {}

  static async connect(config: NearGatewayConfig): Promise<NearContractGateway> {
    const { Account, JsonRpcProvider, KeyPair } = await import("near-api-js");
    const provider = new JsonRpcProvider({ url: config.rpcUrl });
    const publicKey = KeyPair.fromString(config.privateKey as `ed25519:${string}`).getPublicKey().toString();
    await assertRestrictedWorkerAccessKey(provider, config.accountId, publicKey, config.contractId);
    const account = new Account(config.accountId, provider, config.privateKey as `ed25519:${string}`);
    return new NearContractGateway(account, provider, config.contractId);
  }

  async getLedgerAnchor(): Promise<{ root: string; sequence: string }> {
    const result = (await this.provider.callFunction({
      contractId: this.contractId,
      method: "get_config",
      args: {},
    })) as { latest_ledger_root: string; latest_ledger_sequence: string };
    return { root: result.latest_ledger_root, sequence: result.latest_ledger_sequence };
  }

  async getDeposit(commitment: string, depositorId: string): Promise<ContractDeposit | null> {
    const result = (await this.provider.callFunction({
      contractId: this.contractId,
      method: "get_deposit",
      args: { depositor_id: depositorId, commitment },
    })) as null | { commitment: string; depositor_id: string; amount: string };
    if (result === null) return null;
    return {
      commitment: result.commitment,
      depositorId: result.depositor_id,
      amountAtomic: result.amount,
      finalized: true,
    };
  }

  async anchorLedgerRoot(root: string, sequence: string): Promise<{ transactionHash: string }> {
    const outcome = await this.call("anchor_ledger_root", { root, sequence });
    return { transactionHash: transactionHash(outcome) };
  }

  async withdraw(input: {
    withdrawalId: string;
    recipientId: string;
    amountAtomic: string;
    expiryNs: string;
    ledgerRoot: string;
  }): Promise<{ transactionHash: string }> {
    const outcome = await this.call("withdraw", {
      withdrawal_id: input.withdrawalId,
      recipient_id: input.recipientId,
      amount: input.amountAtomic,
      expiry_ns: input.expiryNs,
      ledger_root: input.ledgerRoot,
    });
    return { transactionHash: transactionHash(outcome) };
  }

  async getWithdrawal(withdrawalId: string): Promise<ContractWithdrawal | null> {
    const result = (await this.provider.callFunction({
      contractId: this.contractId,
      method: "get_withdrawal",
      args: { withdrawal_id: withdrawalId },
    })) as null | { withdrawal_id: string; status: ContractWithdrawal["status"]; attempts: number };
    if (result === null) return null;
    return {
      withdrawalId: result.withdrawal_id,
      status: result.status,
      attempts: result.attempts,
    };
  }

  private call(methodName: string, args: Record<string, unknown>) {
    return this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      gas: "30000000000000",
      deposit: "0",
      waitUntil: "FINAL",
    });
  }
}

function transactionHash(outcome: { transaction: { hash: string } }): string {
  return outcome.transaction.hash;
}

export class MemoryContractGateway implements ContractGateway {
  readonly deposits = new Map<string, ContractDeposit>();
  readonly withdrawals = new Map<string, ContractWithdrawal>();
  readonly roots: Array<{ root: string; sequence: string }> = [];
  failNextAnchor = false;
  failNextWithdrawal = false;

  async getLedgerAnchor(): Promise<{ root: string; sequence: string }> {
    return this.roots.at(-1) ?? { root: "", sequence: "0" };
  }

  async getDeposit(commitment: string, depositorId: string): Promise<ContractDeposit | null> {
    const deposit = this.deposits.get(commitment) ?? null;
    return deposit?.depositorId === depositorId ? deposit : null;
  }

  async anchorLedgerRoot(root: string, sequence: string): Promise<{ transactionHash: string }> {
    if (this.failNextAnchor) {
      this.failNextAnchor = false;
      throw new Error("simulated anchor failure");
    }
    this.roots.push({ root, sequence });
    return { transactionHash: `anchor-${sequence}` };
  }

  async withdraw(input: {
    withdrawalId: string;
    recipientId: string;
    amountAtomic: string;
    expiryNs: string;
    ledgerRoot: string;
  }): Promise<{ transactionHash: string }> {
    if (this.failNextWithdrawal) {
      this.failNextWithdrawal = false;
      this.withdrawals.set(input.withdrawalId, {
        withdrawalId: input.withdrawalId,
        status: "FAILED",
        attempts: 1,
      });
      throw new Error("simulated withdrawal failure");
    }
    this.withdrawals.set(input.withdrawalId, {
      withdrawalId: input.withdrawalId,
      status: "COMPLETED",
      attempts: (this.withdrawals.get(input.withdrawalId)?.attempts ?? 0) + 1,
      transactionHash: `withdraw-${input.withdrawalId}`,
    });
    return { transactionHash: `withdraw-${input.withdrawalId}` };
  }

  async getWithdrawal(withdrawalId: string): Promise<ContractWithdrawal | null> {
    return this.withdrawals.get(withdrawalId) ?? null;
  }
}

