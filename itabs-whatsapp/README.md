# itabs-whatsapp

The WhatsApp Cloud API webhook for the WhatsApp Business number +61 421 508 009, via Dualhook (coexistence). It receives only and never sends WhatsApp messages.

- `GET`: Meta's verification handshake (verify token `itabs2026whatsapp`). Returns `hub.challenge`, otherwise 403.
- `POST`: logs the body, replies `200 OK` immediately, then in the background forwards a copy to `keluarga-chat-worker` at `/api/whatsapp/inbound` through the `KELUARGA` Service binding, with header `x-forward-secret`.

## Deploying

Cloudflare Workers Builds deploys this folder on pushes to `main` that change `itabs-whatsapp/`:

| Setting | Value |
|---|---|
| Root directory | `itabs-whatsapp` |
| Build command | (empty) |
| Deploy command | `npx wrangler deploy` |
| Build watch paths (include) | `itabs-whatsapp/*` |

Secrets live in the Cloudflare dashboard (Settings → Variables and Secrets): `KELUARGA_FORWARD_SECRET` (same value as on keluarga-chat-worker) and `DUALHOOK_API_KEY`.
