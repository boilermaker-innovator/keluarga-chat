const TOKEN = "itabs2026whatsapp";

// Where a copy of each incoming webhook is sent for the family inbox.
const KELUARGA_INBOUND_URL =
  "https://keluarga-chat-worker.jgwynne7.workers.dev/api/whatsapp/inbound";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.searchParams.get("hub.verify_token") === TOKEN) {
        return new Response(url.searchParams.get("hub.challenge") || "", {
          status: 200, headers: { "content-type": "text/plain" }
        });
      }
      return new Response("Forbidden", { status: 403 });
    }
    if (req.method === "POST") {
      const body = await req.text();
      console.log(body);
      // Forward a copy in the background. Meta gets its 200 straight away,
      // and nothing that happens in the forward can change that.
      ctx.waitUntil(forwardToKeluarga(body, env));
      return new Response("OK", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }
};

async function forwardToKeluarga(body, env) {
  if (!env.KELUARGA_FORWARD_SECRET) {
    console.log("Forward skipped: KELUARGA_FORWARD_SECRET is not set.");
    return;
  }
  if (!env.KELUARGA) {
    console.log("Forward skipped: add a Service binding named KELUARGA (service: keluarga-chat-worker).");
    return;
  }
  try {
    // The Service binding calls keluarga-chat-worker directly. Cloudflare
    // blocks one of your Workers fetching another through workers.dev.
    const res = await env.KELUARGA.fetch(KELUARGA_INBOUND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forward-secret": env.KELUARGA_FORWARD_SECRET
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      console.log("Forwarded to keluarga-chat-worker: " + (await res.text()).slice(0, 200));
    } else {
      console.log("Forward to keluarga-chat-worker failed: HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    }
  } catch (err) {
    console.log("Forward to keluarga-chat-worker failed: " + (err && err.message ? err.message : err));
  }
}
