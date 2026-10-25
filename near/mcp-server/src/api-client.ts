export class PrivacyApiClient {
  constructor(readonly baseUrl: string, private token: string, private readonly fetcher: typeof fetch = fetch) {}

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
      signal: AbortSignal.timeout(20_000),
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
