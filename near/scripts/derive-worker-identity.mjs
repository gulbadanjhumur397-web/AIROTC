import { boxPublicKeyFromSecret, bytesToBase64Url, base64UrlToBytes, workerEncryptionKeyHash } from "../shared-types/dist/index.js";
import { required } from "./phase9-lib.mjs";

const workerId = required("TEE_NEAR_ACCOUNT_ID");
const encryptionKeyId = required("TEE_ENCRYPTION_KEY_ID");
const secret = base64UrlToBytes(required("TEE_BOX_SECRET_KEY_B64URL"));
if (secret.length !== 32) throw new Error("TEE_BOX_SECRET_KEY_B64URL must encode exactly 32 bytes");
const identity = {
  workerId,
  encryptionKeyId,
  encryptionPublicKey: bytesToBase64Url(boxPublicKeyFromSecret(secret)),
};
process.stdout.write(`${JSON.stringify({ identity, encryptionKeyHash: workerEncryptionKeyHash(identity) }, null, 2)}\n`);
