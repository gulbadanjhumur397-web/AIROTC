import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { baseDecode, KeyPair } from "near-api-js";
import { requireAccount, required } from "./phase9-lib.mjs";

const role = required("AGENT_ROLE").toUpperCase();
if (role !== "BUYER" && role !== "SELLER") throw new Error("AGENT_ROLE must be BUYER or SELLER");
const accountId = requireAccount(required("AGENT_ACCOUNT_ID"), "AGENT_ACCOUNT_ID");
const privateKey = required("AGENT_ACCOUNT_PRIVATE_KEY");
const output = resolve(required("AGENT_SECRET_FILE"));
const keyPair = KeyPair.fromString(privateKey);
const decoded = baseDecode(privateKey.slice("ed25519:".length));
if (decoded.length !== 64) throw new Error("AGENT_ACCOUNT_PRIVATE_KEY must contain an extended Ed25519 key");
const signingSeed = Buffer.from(decoded.slice(0, 32)).toString("base64url");
const boxSecret = randomBytes(32).toString("base64url");
const prefix = `DEMO_${role}`;
const handle = await open(output, "wx", 0o600);
try {
  await handle.writeFile([
    `${prefix}_ACCOUNT_ID=${accountId}`,
    `${prefix}_SIGNING_SEED_B64URL=${signingSeed}`,
    `${prefix}_BOX_SECRET_B64URL=${boxSecret}`,
    `${prefix}_BOX_KEY_ID=demo-${role.toLowerCase()}-box-v1`,
    "",
  ].join("\n"));
} finally {
  await handle.close();
}
process.stdout.write(`${JSON.stringify({ role, accountId, publicKey: keyPair.getPublicKey().toString(), secretFile: output }, null, 2)}\n`);
