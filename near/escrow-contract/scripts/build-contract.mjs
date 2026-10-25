import { mkdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await new Promise((resolve, reject) => {
  const child = spawn(
    "cargo",
    ["near", "build", "non-reproducible-wasm", "--locked", "--no-abi", "--out-dir", "build/cargo-near"],
    {
    cwd: directory,
    stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cargo build exited with ${code}`))));
});

const outputDirectory = path.join(directory, "build");
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  path.join(directory, "build", "cargo-near", "air_otc_near_pool.wasm"),
  path.join(outputDirectory, "air-otc-pool.wasm"),
);

