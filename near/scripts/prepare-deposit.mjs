import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { createDepositCommitment } from "../shared-types/dist/index.js";
import { required } from "./phase9-lib.mjs";

const role = required("DEPOSIT_ROLE").toUpperCase();
if (role !== "BUYER" && role !== "SELLER") throw new Error("DEPOSIT_ROLE must be BUYER or SELLER");
const output = resolve(required("DEPOSIT_SECRET_FILE"));
const secret = randomBytes(32).toString("base64url");
const commitment = createDepositCommitment(secret);
const handle = await open(output, "wx", 0o600);
try {
  await handle.writeFile(`DEMO_${role}_DEPOSIT_SECRET=${secret}\n`);
} finally {
  await handle.close();
}
process.stdout.write(`${JSON.stringify({ role, commitment, secretFile: output }, null, 2)}\n`);
