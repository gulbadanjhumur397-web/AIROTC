export class PrivacyApiClient {
  constructor(
    readonly baseUrl: string,
    private token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = 90_000,
  ) {
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 300_000) {
      throw new Error("Privacy API request timeout must be between 1000 and 300000 milliseconds");
    }
  }

  async get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  async mutate(method: "POST" | "PUT", path: string, requestId: string, body: unknown, spendAtomic?: string): Promise<unknown> {
    return this.request(method, path, body, requestId, spendAtomic);
  }

  replaceToken(token: string): void {
    if (!token.startsWith("airotc_near_")) throw new Error("Rotated token is invalid");
    this.token = token;
  }

  private async request(method: string, path: string, body?: unknown, requestId?: string, spendAtomic?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (requestId !== undefined) headers["x-airotc-request-id"] = requestId;
    if (spendAtomic !== undefined) headers["x-airotc-spend-atomic"] = spendAtomic;
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) {
      const code = safeText(value?.error?.code, "API_REJECTED");
      const message = safeText(value?.error?.message, "Request was rejected");
      throw new Error(`${code}: ${message}`);
    }
    return value;
  }
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9 _.:/-]{1,160}$/.test(value) ? value : fallback;
}
