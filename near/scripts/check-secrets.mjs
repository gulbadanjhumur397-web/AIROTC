import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const root = new URL("../../", import.meta.url);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);

const forbiddenNames = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:id_ed25519|id_rsa|.*\.(?:pem|p12|pfx|key))$/i,
  /(^|\/)ledger\.snapshot$/,
  /(^|\/).*\.(?:db|sqlite|sqlite3)$/i,
];
const allowedExample = /(?:^|\/)(?:\.env\.example|testnet\.env\.example)$/;
const contentPatterns = [
  ["NEAR private key", /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g],
  ["AIR OTC MCP token", /airotc_near_[A-Za-z0-9_-]{32,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["private-key PEM", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];
const secretVariable = /^(?:[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|BOX_SECRET|LEDGER_KEY|DATABASE_KEY|HANDLE_SECRET)[A-Z0-9_]*|[A-Z0-9_]*(?:API_TOKEN|AUTH_TOKEN|MCP_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)|TOKEN)$/;
const placeholderValue = /^(?:replace-|ed25519:replace-|your-|base58_or_|changeme|example|dummy|test-|\$\{|<)/i;
const textExtensions = new Set(["", ".cjs", ".css", ".env", ".example", ".html", ".js", ".json", ".md", ".mjs", ".rs", ".toml", ".ts", ".tsx", ".yaml", ".yml"]);
const findings = [];

for (const file of files) {
  if (!allowedExample.test(file) && forbiddenNames.some((pattern) => pattern.test(file))) {
    findings.push({ file, issue: "secret-bearing filename must not be committed" });
  }
  if (!textExtensions.has(extname(file))) continue;
  let value;
  try {
    value = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
  } catch {
    continue;
  }
  for (const [issue, pattern] of contentPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) findings.push({ file, issue });
  }
  if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.env\.example)$/.test(file)) {
    for (const line of value.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)[ \t]*=[ \t]*([^\s#]*)/.exec(line);
      if (match && secretVariable.test(match[1]) && match[2] && !placeholderValue.test(match[2])) {
        findings.push({ file, issue: "assigned secret" });
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, scannedFiles: files.length, findings: 0 })}\n`);
}
