# Demonstration API product

This minimal service proves that the delivered API credential works. Configure a
secret value as `DEMO_API_KEY`, start `node server.mjs`, and expose it through HTTPS
during the hosted demo. The seller encrypts the URL and credential for the buyer.
The two-agent runner decrypts them and calls `GET /v1/proof` with the credential.

The service logs only its listen event. It never logs request headers or the key.
`GET /health` is public; `GET /v1/proof` returns `credential-accepted` only for the
correct bearer credential.
