import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { assertTestnetChain, explorerTransaction, requireAccount, requireAtomic, required, requireTestnetRpc, writeEvidence } from "./phase9-lib.mjs";

const nearRoot = resolve(new URL("../", import.meta.url).pathname);
const serverPath = resolve(nearRoot, "mcp-server/dist/index.js");
if (process.argv.includes("--check")) {
  await access(serverPath);
  process.stdout.write(`${JSON.stringify({ ok: true, mcpServer: serverPath, mode: "configuration-check" })}\n`);
  process.exit(0);
}
const localMode = process.argv.includes("--local");
if (!localMode && process.env.ALLOW_UNVERIFIED_DEV_ATTESTATION === "true") {
  throw new Error("Hosted two-agent evidence cannot use development attestation");
}

const apiUrl = required("PRIVACY_API_URL");
const rpcUrl = requireTestnetRpc(required("NEAR_RPC_URL"));
await assertTestnetChain(rpcUrl);
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const buyerId = requireAccount(required("DEMO_BUYER_ACCOUNT_ID"), "DEMO_BUYER_ACCOUNT_ID");
const sellerId = requireAccount(required("DEMO_SELLER_ACCOUNT_ID"), "DEMO_SELLER_ACCOUNT_ID");
if (buyerId === sellerId) throw new Error("Buyer and seller accounts must be different");

class McpProcess {
  constructor(name, environment) {
    this.name = name;
    this.environment = environment;
    this.nextId = 1;
    this.pending = new Map();
  }
  async start() {
    this.child = spawn(process.execPath, [serverPath], {
      cwd: nearRoot,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: localMode ? "development" : "production",
        TZ: process.env.TZ ?? "UTC",
        ...this.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handle(line));
    this.child.stderr.on("data", () => {});
    this.child.once("exit", (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${this.name} MCP process exited with code ${code}`));
      this.pending.clear();
    });
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "airotc-demo", version: "1" } });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} MCP request timed out`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolvePromise(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  handle(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`MCP protocol error ${message.error.code}`));
    else pending.resolve(message.result);
  }
  stop() {
    this.child?.kill("SIGTERM");
  }
}

const buyer = new McpProcess("buyer", agentEnvironment("BUYER", buyerId));
const seller = new McpProcess("seller", agentEnvironment("SELLER", sellerId));
const calls = [];
try {
  await Promise.all([buyer.start(), seller.start()]);
  await Promise.all([ensureTools(buyer), ensureTools(seller)]);

  const priceAtomic = requireAtomic(process.env.DEMO_PRICE_ATOMIC ?? "100000000000000000000000", "DEMO_PRICE_ATOMIC", false);
  const buyerCollateralAtomic = requireAtomic(process.env.DEMO_BUYER_COLLATERAL_ATOMIC ?? "20000000000000000000000", "DEMO_BUYER_COLLATERAL_ATOMIC");
  const sellerCollateralAtomic = requireAtomic(process.env.DEMO_SELLER_COLLATERAL_ATOMIC ?? "20000000000000000000000", "DEMO_SELLER_COLLATERAL_ATOMIC");
  const buyerRequired = (BigInt(priceAtomic) + BigInt(buyerCollateralAtomic)).toString();
  const sellerRequired = sellerCollateralAtomic;

  await ensureBalance(buyer, "buyer", buyerRequired, process.env.DEMO_BUYER_DEPOSIT_SECRET, calls);
  await ensureBalance(seller, "seller", sellerRequired, process.env.DEMO_SELLER_DEPOSIT_SECRET, calls);

  const productSecret = required("DEMO_PRODUCT_SECRET");
  const publicLabel = process.env.DEMO_PRODUCT_PUBLIC_LABEL ?? "AIR OTC test API access";
  const validationUrl = requireValidationUrl(required("DEMO_PRODUCT_VALIDATION_URL"), localMode);
  const product = { type: "API_ACCESS", label: publicLabel, validationUrl, credential: productSecret };
  const tagHash = sha256("api-access");
  const listing = await call(seller, "seller", "marketplace_create", {
    requestId: requestId("listing"), kind: "API_ACCESS", tagHashes: [tagHash], product,
  }, calls);
  const listingRef = text(listing.listingRef, "listingRef");
  const market = await call(buyer, "buyer", "marketplace_list", { tagHash }, calls);
  if (!Array.isArray(market.listings) || !market.listings.some((entry) => entry?.listingRef === listingRef)) {
    throw new Error("Buyer did not find the seller listing");
  }
  const ticket = await call(buyer, "buyer", "ticket_create", { requestId: requestId("ticket"), listingRef }, calls);
  const ticketRef = text(ticket.ticketRef, "ticketRef");
  await call(buyer, "buyer", "ticket_send_message", {
    requestId: requestId("message"), ticketRef, message: "I am ready to agree exact structured terms.",
  }, calls);
  await call(seller, "seller", "ticket_send_message", {
    requestId: requestId("message"), ticketRef, message: "I will deliver after the confidential match locks both balances.",
  }, calls);

  const now = BigInt(Date.now()) * 1_000_000n;
  const terms = {
    version: 1,
    ticketId: ticketRef,
    buyerId,
    sellerId,
    assetDescriptionHash: sha256(publicLabel),
    currency: "NEAR_TESTNET",
    priceAtomic,
    buyerCollateralAtomic,
    sellerCollateralAtomic,
    fundingDeadlineNs: (now + 15n * 60n * 1_000_000_000n).toString(),
    deliveryDeadlineNs: (now + 30n * 60n * 1_000_000_000n).toString(),
    confirmationDeadlineNs: (now + 45n * 60n * 1_000_000_000n).toString(),
    sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL",
    buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
    nonce: nonce(),
    expiresAtNs: (now + 10n * 60n * 1_000_000_000n).toString(),
  };
  const mismatch = { ...terms, priceAtomic: (BigInt(priceAtomic) + 1n).toString() };
  const mismatchBuyer = await call(buyer, "buyer", "terms_submit", {
    requestId: requestId("terms"), submissionNonce: nonce(), role: "BUYER", terms,
  }, calls);
  const mismatchSeller = await call(seller, "seller", "terms_submit", {
    requestId: requestId("terms"), submissionNonce: nonce(), role: "SELLER", terms: mismatch,
  }, calls);
  if (mismatchBuyer.status !== "WAITING_FOR_COUNTERPARTY" || mismatchSeller.status !== "NO_MATCH") {
    throw new Error("Intentional terms mismatch did not produce the expected NO_MATCH result");
  }

  await call(seller, "seller", "terms_submit", {
    requestId: requestId("terms"), submissionNonce: nonce(), role: "SELLER", terms,
  }, calls);
  const match = await call(buyer, "buyer", "terms_submit", {
    requestId: requestId("terms"), submissionNonce: nonce(), role: "BUYER", terms,
  }, calls);
  if (match.status !== "MATCH" || match.dealStatus !== "FUNDED") {
    throw new Error(`Expected funded MATCH, received ${String(match.status)}/${String(match.dealStatus)}`);
  }

  const stored = await call(seller, "seller", "delivery_store", {
    requestId: requestId("delivery"), ticketRef, delivery: product,
  }, calls);
  const deliveryCommitment = text(stored.deliveryCommitment, "deliveryCommitment");
  await call(seller, "seller", "delivery_submit", {
    requestId: requestId("delivery"), actionNonce: nonce(), ticketId: ticketRef, deliveryCommitment,
  }, calls);
  const received = await call(buyer, "buyer", "delivery_get", { ticketRef }, calls);
  if (JSON.stringify(received.delivery) !== JSON.stringify(product)) throw new Error("Buyer could not decrypt the delivered product");
  await validateDeliveredProduct(received.delivery);
  await call(buyer, "buyer", "delivery_confirm", {
    requestId: requestId("confirm"), actionNonce: nonce(), ticketId: ticketRef,
  }, calls);
  const finalDeal = await call(buyer, "buyer", "deal_status", {
    requestId: requestId("status"), actionNonce: nonce(), ticketId: ticketRef,
  }, calls);
  if (finalDeal.deal?.status !== "COMPLETED") throw new Error("Deal did not settle as COMPLETED");

  const buyerWithdrawal = await withdraw(buyer, "buyer", required("DEMO_BUYER_WITHDRAW_ATOMIC"), calls);
  const sellerWithdrawal = await withdraw(seller, "seller", required("DEMO_SELLER_WITHDRAW_ATOMIC"), calls);
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: localMode ? "local-development" : "hosted-testnet",
    network: "testnet",
    contractId,
    parties: { buyerId, sellerId, independentProcesses: true, separateTokens: true },
    listingRef,
    ticketRef,
    mismatch: { buyerStatus: mismatchBuyer.status, sellerStatus: mismatchSeller.status },
    match: { status: match.status, dealStatus: match.dealStatus, termsHash: match.termsHash },
    delivery: { commitment: deliveryCommitment, buyerDecryptionVerified: true, productUseVerified: true },
    settlement: { status: finalDeal.deal.status },
    withdrawals: {
      buyer: publicWithdrawal(buyerWithdrawal),
      seller: publicWithdrawal(sellerWithdrawal),
    },
    toolCalls: calls,
    assertions: {
      noDirectDatabaseAccess: true,
      agentsUsedOnlyMcp: true,
      productSecretWrittenToEvidence: false,
      termsWrittenToEvidence: false,
    },
  };
  const evidenceFile = required("PHASE9_EVIDENCE_FILE");
  const written = await writeEvidence(evidenceFile, evidence);
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceFile: written, ticketRef, withdrawals: evidence.withdrawals }, null, 2)}\n`);
} finally {
  buyer.stop();
  seller.stop();
}

function agentEnvironment(role, accountId) {
  return {
    PRIVACY_API_URL: apiUrl,
    NEAR_RPC_URL: rpcUrl,
    NEAR_POOL_CONTRACT_ID: contractId,
    ALLOW_UNVERIFIED_DEV_ATTESTATION: localMode ? "true" : "false",
    AIROTC_MCP_TOKEN: required(`DEMO_${role}_MCP_TOKEN`),
    AIROTC_ACCOUNT_ID: accountId,
    AIROTC_SIGNING_SEED_B64URL: required(`DEMO_${role}_SIGNING_SEED_B64URL`),
    AIROTC_BOX_SECRET_B64URL: required(`DEMO_${role}_BOX_SECRET_B64URL`),
    AIROTC_BOX_KEY_ID: process.env[`DEMO_${role}_BOX_KEY_ID`] ?? `demo-${role.toLowerCase()}-box-v1`,
  };
}

async function ensureTools(agent) {
  const listed = await agent.request("tools/list", {});
  if (!Array.isArray(listed.tools) || listed.tools.length !== 22) throw new Error(`${agent.name} MCP server did not expose 22 tools`);
}

async function ensureBalance(agent, role, requiredAtomic, depositSecret, calls) {
  let result = await call(agent, role, "pool_get_balance", { requestId: requestId("balance"), actionNonce: nonce() }, calls);
  if (BigInt(result.balance.availableAtomic) >= BigInt(requiredAtomic)) return;
  if (!depositSecret) throw new Error(`${role} private balance is insufficient and no reusable deposit secret was supplied`);
  await call(agent, role, "pool_claim_deposit", {
    requestId: requestId("deposit"), actionNonce: nonce(), depositSecret,
  }, calls);
  result = await call(agent, role, "pool_get_balance", { requestId: requestId("balance"), actionNonce: nonce() }, calls);
  if (BigInt(result.balance.availableAtomic) < BigInt(requiredAtomic)) throw new Error(`${role} balance remains insufficient after claiming deposit`);
}

async function withdraw(agent, role, amount, calls) {
  requireAtomic(amount, `${role} withdrawal`, false);
  const result = await call(agent, role, "withdrawal_request", {
    requestId: requestId("withdraw"), actionNonce: nonce(), amountAtomic: amount,
  }, calls);
  if (result.withdrawalStatus !== "COMPLETED" || !result.transactionHash) throw new Error(`${role} withdrawal did not complete on testnet`);
  return result;
}

async function call(agent, role, name, args, calls) {
  const started = Date.now();
  try {
    const response = await agent.request("tools/call", { name, arguments: args });
    if (response.isError) throw new Error(response.content?.[0]?.text ?? "MCP tool failed");
    calls.push({ sequence: calls.length + 1, role, tool: name, outcome: "ok", durationMs: Date.now() - started });
    return response.structuredContent;
  } catch (error) {
    calls.push({ sequence: calls.length + 1, role, tool: name, outcome: "error", durationMs: Date.now() - started });
    throw error;
  }
}

function publicWithdrawal(value) {
  return {
    withdrawalId: value.withdrawalId,
    status: value.withdrawalStatus,
    transactionHash: value.transactionHash,
    explorerUrl: explorerTransaction(value.transactionHash),
  };
}

function requestId(prefix) { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function nonce() { return randomBytes(24).toString("base64url"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function text(value, field) { if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is missing`); return value; }

function requireValidationUrl(value, allowLocal) {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) {
    throw new Error("DEMO_PRODUCT_VALIDATION_URL must use HTTPS for the hosted run");
  }
  if (url.pathname !== "/v1/proof") throw new Error("DEMO_PRODUCT_VALIDATION_URL must target /v1/proof");
  return url.toString();
}

async function validateDeliveredProduct(value) {
  if (!value || typeof value !== "object") throw new Error("Delivered product is invalid");
  const response = await fetch(value.validationUrl, {
    headers: { authorization: `Bearer ${value.credential}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true || result?.result !== "credential-accepted") {
    throw new Error("Delivered API credential failed product validation");
  }
}
