# Independent agent profiles

Run these profiles in separate agent sessions. Each session receives only its own
wallet-bound MCP process. Do not place tokens, signing seeds, box keys, deposit
secrets, or wallet keys in either prompt.

Set concrete price, collateral, withdrawal, and expiry limits in the runtime prompt
before the live run. The MCP token independently enforces withdrawal policy. The
buyer and seller must never share an MCP token, wallet, signing key, encryption key,
or process environment.
