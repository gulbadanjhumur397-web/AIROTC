import type { IdentityVerifier } from "./types.js";

export class NearRpcIdentityVerifier implements IdentityVerifier {
  constructor(
    private readonly rpcUrl: string,
    private readonly poolContractId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async isAuthorizedKey(accountId: string, publicKey: string): Promise<boolean> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "airotc-key-check",
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`NEAR RPC key check failed with HTTP ${response.status}`);
    const result = (await response.json()) as {
      result?: { permission?: "FullAccess" | { FunctionCall?: { receiver_id?: string } } };
      error?: unknown;
    };
    if (result.error) return false;
    const permission = result.result?.permission;
    return permission === "FullAccess" || permission?.FunctionCall?.receiver_id === this.poolContractId;
  }
}

export class StaticIdentityVerifier implements IdentityVerifier {
  constructor(private readonly allowed: ReadonlyMap<string, ReadonlySet<string>>) {}

  async isAuthorizedKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.allowed.get(accountId)?.has(publicKey) === true;
  }
}

