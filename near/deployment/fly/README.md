# Fly deployment

These files deploy only the new AIROTC service boundary. They do not target or
modify any legacy `air-arena-*` application.

| App | Config | Public role |
| --- | --- | --- |
| `airotc-privacy-api-gulbadan` | `privacy-api.fly.toml` | Wallet authentication, ciphertext routing, encrypted API state |
| `airotc-demo-api-gulbadan` | `demo-api.fly.toml` | Demonstration product credential validation |

The privacy API mounts the encrypted volume `airotc_privacy_data` at
`/var/lib/airotc`. Runtime encryption keys and the demo credential are Fly secrets;
they are not stored in these files. Both apps use health checks, HTTPS, one shared
CPU, 256 MB memory, Singapore as the primary region, and scale to zero when idle.
Browser CORS is disabled because no frontend is deployed; set `WEB_ORIGIN` to the
exact frontend origin only if a frontend is intentionally added later.

MCP is launched separately for each agent over stdio. Hosting one shared MCP process
would combine buyer and seller secrets and violate the identity-isolation design.
