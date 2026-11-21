// Keluarga Chat Worker.
//
// One Worker serves the page (site/, via the ASSETS binding) and the API:
//   POST /api/translate          - the translator page (family passcode)
//   POST /api/whatsapp/inbound   - webhooks forwarded by the itabs-whatsapp
//                                  Worker (shared secret)
//   /api/inbox/*                 - the PIN-protected WhatsApp inbox
//
// Secrets (Cloudflare dashboard or `npx wrangler secret put <NAME>`):
//   ANTHROPIC_API_KEY        - your Anthropic API key
//   FAMILY_PASSCODE          - the translator page's passcode
//   KELUARGA_FORWARD_SECRET  - same value as on itabs-whatsapp; forwards
//                              without it are refused
//   DUALHOOK_API_KEY         - for sending replies through Dualhook
//   INBOX_PIN                - the inbox PIN (at least 6 characters)
// Vars (wrangler.toml):
//   ALLOWED_ORIGINS          - other page origins allowed to call /api/translate
//   DUALHOOK_API_BASE, DUALHOOK_PHONE_NUMBER_ID - where replies are sent
// Bindings (wrangler.toml):
//   ASSETS        - the static files in site/
//   RATE_LIMITER  - per-IP limit for translations
//   PIN_LIMITER   - per-IP limit for PIN attempts
//   INBOX_DO      - Durable Object (SQLite) holding family list and messages

import {
  translate,
  errorResponse,
  corsHeaders,
  passcodeMatches,
  json,
  MAX_INPUT_CHARS,
  DIRECTIONS,
  REGISTERS,
} from "./core.js";
import { handleInbound, handleInboxApi } from "./inbox.js";

export { InboxStore } from "./inbox.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Anything outside /api/ is the page itself.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found.", { status: 404 });
    }

    if (url.pathname === "/api/whatsapp/inbound") {
      return handleInbound(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/inbox/")) {
      return handleInboxApi(request, env, ctx, url);
    }

    const cors = corsHeaders(request, env, url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    }

    if (url.pathname !== "/api/translate") {
      return json({ error: "Not found." }, 404, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "Use POST." }, 405, cors);
    }
    if (!cors) {
      // Browsers from other sites are refused. (Non-browser callers can fake
      // Origin, which is why the passcode below is the real gate.)
      return json({ error: "This page is not allowed to use the translator." }, 403);
    }

    if (!env.ANTHROPIC_API_KEY || !env.FAMILY_PASSCODE) {
      return json({ error: "The Worker is missing a secret. See the README setup steps." }, 500, cors);
    }

    const passcode = request.headers.get("X-Family-Passcode") ?? "";
    if (!(await passcodeMatches(passcode, env.FAMILY_PASSCODE))) {
      return json({ error: "Wrong family passcode." }, 401, cors);
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json({ error: "Too many translations in a short time. Wait a minute and try again." }, 429, cors);
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Request body must be JSON." }, 400, cors);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const direction = body.direction;
    const register = REGISTERS.has(body.register) ? body.register : "polite";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 40) : "";

    if (!text) return json({ error: "Type a message to translate." }, 400, cors);
    if (text.length > MAX_INPUT_CHARS) {
      return json({ error: `Messages are limited to ${MAX_INPUT_CHARS} characters.` }, 400, cors);
    }
    if (!DIRECTIONS.has(direction)) {
      return json({ error: "Unknown translation direction." }, 400, cors);
    }

    try {
      const result = await translate(env, { text, direction, register, title });
      return json(result, 200, cors);
    } catch (err) {
      return errorResponse(err, cors);
    }
  },
};
