import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const key = process.env.DEMO_API_KEY;
if (!key || key.length < 24) throw new Error("DEMO_API_KEY must contain at least 24 characters");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "8070", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
const keyHash = createHash("sha256").update(key).digest();

const server = createServer((request, response) => {
  securityHeaders(response);
  const url = new URL(request.url ?? "/", "http://demo-api.invalid");
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true, service: "air-otc-demo-api" });
  }
  if (request.method === "GET" && url.pathname === "/v1/proof") {
    const authorization = request.headers.authorization ?? "";
    const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const candidateHash = createHash("sha256").update(candidate).digest();
    if (!timingSafeEqual(keyHash, candidateHash)) return json(response, 401, { error: "INVALID_CREDENTIAL" });
    return json(response, 200, { ok: true, product: "air-otc-demo-api", result: "credential-accepted" });
  }
  return json(response, 404, { error: "NOT_FOUND" });
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ level: "info", event: "demo_api_listening", host, port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => {}));
}

function securityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
