import { KeyPair } from "near-api-js";
import { required } from "./phase9-lib.mjs";

const privateKey = required("TEE_NEAR_PRIVATE_KEY");
const publicKey = KeyPair.fromString(privateKey).getPublicKey().toString();
process.stdout.write(`${publicKey}\n`);
