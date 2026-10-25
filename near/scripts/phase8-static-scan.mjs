import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const ignored = new Set(["node_modules", "dist", "build", "target", ".git", ".secrets", "evidence"]);
const files = await walk(root);
const failures = [];

const productionSources = files.filter((file) => /\/(shared-types|tee-worker|privacy-api|mcp-server|web)\/src\/.+\.(ts|tsx)$/.test(file));
for (const file of productionSources) {
  const text = await readFile(file, "utf8");
  if (/middleman-agent|aiJudge|openai\b|anthropic\b/i.test(text)) {
    failures.push(`${relative(file)} imports or names a forbidden LLM/middleman runtime`);
  }
}

const contract = (await readFile(path.join(root, "escrow-contract/src/lib.rs"), "utf8")).split("#[cfg(test)]", 1)[0];
for (const privateField of ["ticket_id", "deal_id", "price_atomic", "buyer_collateral", "seller_collateral", "delivery_commitment", "private_balance"]) {
  if (contract.includes(privateField)) failures.push(`escrow-contract/src/lib.rs exposes private field ${privateField}`);
}

for (const file of files.filter((candidate) => /\.env(?:\.|$)/.test(path.basename(candidate)))) {
  if (!file.endsWith(".env.example")) failures.push(`${relative(file)} is a non-example environment file`);
  const text = await readFile(file, "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) failures.push(`${relative(file)} contains a private-key block`);
  if (/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(text)) failures.push(`${relative(file)} contains a plausible NEAR private key`);
  if (/airotc_near_[A-Za-z0-9_-]{32,}/.test(text)) failures.push(`${relative(file)} contains a plausible live MCP token`);
}

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, failures }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  productionSourcesScanned: productionSources.length,
  environmentFilesScanned: files.filter((file) => file.endsWith(".env.example")).length,
  contractPrivateFieldsFound: 0,
})}\n`);

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else result.push(absolute);
  }
  return result;
}

function relative(file) {
  return path.relative(root, file);
}
