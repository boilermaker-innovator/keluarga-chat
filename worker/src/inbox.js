// WhatsApp inbox for Keluarga Chat.
//
// - handleInbound: webhooks forwarded by the itabs-whatsapp Worker (checked
//   with KELUARGA_FORWARD_SECRET). Only messages from relatives on the family
//   list are stored and translated; everyone else is ignored. Nothing in this
//   path ever sends a WhatsApp message.
// - handleInboxApi: the PIN-protected inbox page's API. Sending happens only
//   in POST /api/inbox/send, which the page calls when you tap Send.
// - InboxStore: one SQLite-backed Durable Object holding the family list,
//   messages and delivery statuses.

import { DurableObject } from "cloudflare:workers";
import { translate, errorResponse, passcodeMatches, json, MAX_INPUT_CHARS, REGISTERS } from "./core.js";

const WINDOW_MS = 24 * 60 * 60 * 1000; // Meta's customer service window
const SEND_MARGIN_MS = 2 * 60 * 1000; // stop a couple of minutes early
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = "kc_inbox";
const MIN_PIN_LENGTH = 6;
const MAX_WA_TEXT = 4096;
const THREAD_LIMIT = 300;
const STATUS_RANK = { sending: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class InboxStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS family (
      wa_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      reg TEXT NOT NULL DEFAULT 'polite',
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      wa_id TEXT NOT NULL,
      dir TEXT NOT NULL,            -- 'in' or 'out'
      source TEXT NOT NULL,         -- 'whatsapp' (them), 'inbox' (sent here), 'phone' (sent from the app)
      kind TEXT NOT NULL,           -- text, image, audio, video, document, sticker, reaction, location, other
      original TEXT NOT NULL DEFAULT '',
      english TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      time INTEGER NOT NULL,
      client_id TEXT UNIQUE,
      wamid TEXT UNIQUE
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (wa_id, time)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reads (wa_id TEXT PRIMARY KEY, read_at INTEGER NOT NULL)`);
    // Status webhooks can arrive before we've stored the wamid of a message
    // we just sent; they wait here until it's stored.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pending_status (
      wamid TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', time INTEGER NOT NULL
    )`);
  }

  rows(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }

  // ----- family -----

  listFamily() {
    return this.rows(`SELECT wa_id, name, title, reg FROM family ORDER BY name COLLATE NOCASE`);
  }

  getFamily(waId) {
    return this.rows(`SELECT wa_id, name, title, reg FROM family WHERE wa_id = ?`, waId)[0] ?? null;
  }

  upsertFamily({ wa_id, name, title, reg }) {
    this.sql.exec(
      `INSERT INTO family (wa_id, name, title, reg, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wa_id) DO UPDATE SET name = excluded.name, title = excluded.title, reg = excluded.reg`,
      wa_id, name, title, reg, Date.now(),
    );
    return this.getFamily(wa_id);
  }

  // Removing a relative also deletes their chat history from the inbox.
  removeFamily(waId) {
    this.sql.exec(`DELETE FROM family WHERE wa_id = ?`, waId);
    this.sql.exec(`DELETE FROM messages WHERE wa_id = ?`, waId);
    this.sql.exec(`DELETE FROM reads WHERE wa_id = ?`, waId);
    return true;
  }

  // ----- incoming -----

  // Returns { stored, family } - stored is false for non-family or duplicates.
  addInbound(m) {
    const family = this.getFamily(m.wa_id);
    if (!family) return { stored: false, family: null };
    const cur = this.sql.exec(
      `INSERT OR IGNORE INTO messages (id, wa_id, dir, source, kind, original, time) VALUES (?, ?, 'in', 'whatsapp', ?, ?, ?)`,
      m.id, m.wa_id, m.kind, m.original, m.time,
    );
    return { stored: cur.rowsWritten > 0, family };
  }

  // A message you sent from the WhatsApp Business app on your phone.
  addEcho(m) {
    if (!this.getFamily(m.wa_id)) return false;
    const cur = this.sql.exec(
      `INSERT OR IGNORE INTO messages (id, wa_id, dir, source, kind, original, status, time, wamid)
       VALUES (?, ?, 'out', 'phone', ?, ?, 'sent', ?, ?)`,
      "echo_" + m.id, m.wa_id, m.kind, m.original, m.time, m.id,
    );
    return cur.rowsWritten > 0;
  }

  setTranslation(id, { english = "", notes = "", error = "" }) {
    this.sql.exec(`UPDATE messages SET english = ?, notes = ?, error = ? WHERE id = ?`, english, notes, error, id);
  }

  getMessage(id) {
    return this.rows(`SELECT * FROM messages WHERE id = ?`, id)[0] ?? null;
  }

  // ----- statuses -----

  applyStatus({ wamid, status, error = "", time = Date.now() }) {
    const row = this.rows(`SELECT id, status FROM messages WHERE wamid = ?`, wamid)[0];
    if (!row) {
      this.sql.exec(
        `INSERT INTO pending_status (wamid, status, error, time) VALUES (?, ?, ?, ?)
         ON CONFLICT(wamid) DO UPDATE SET status = excluded.status, error = excluded.error, time = excluded.time
         WHERE excluded.status = 'failed' OR excluded.time >= pending_status.time`,
        wamid, status, error, time,
      );
      // Old pending rows are of no use.
      this.sql.exec(`DELETE FROM pending_status WHERE time < ?`, Date.now() - WINDOW_MS);
      return false;
    }
    if (status === "failed") {
      this.sql.exec(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`, error || "WhatsApp could not deliver this message.", row.id);
      return true;
    }
    if (row.status === "failed") return false;
    if ((STATUS_RANK[status] ?? -1) > (STATUS_RANK[row.status] ?? -1)) {
      this.sql.exec(`UPDATE messages SET status = ? WHERE id = ?`, status, row.id);
      return true;
    }
    return false;
  }

  // ----- outgoing (sent from the inbox) -----

  lastInbound(waId) {
    const r = this.rows(`SELECT MAX(time) AS t FROM messages WHERE wa_id = ? AND dir = 'in'`, waId)[0];
    return r && r.t ? r.t : null;
  }

  // Reserves a message before calling Dualhook, so a double tap (same
  // client_id) can never send twice, and enforces the 24-hour window.
  reserveOutbound({ client_id, wa_id, original, english, now }) {
    const existing = this.rows(`SELECT * FROM messages WHERE client_id = ?`, client_id)[0];
    if (existing) return { existing };
    if (!this.getFamily(wa_id)) return { error: "not_family" };
    const last = this.lastInbound(wa_id);
    if (!last || now - last > WINDOW_MS - SEND_MARGIN_MS) return { error: "window_closed", last_inbound: last };
    const id = "out_" + client_id;
    this.sql.exec(
      `INSERT INTO messages (id, wa_id, dir, source, kind, original, english, status, time, client_id)
       VALUES (?, ?, 'out', 'inbox', 'text', ?, ?, 'sending', ?, ?)`,
      id, wa_id, original, english, now, client_id,
    );
    return { message: this.getMessage(id) };
  }

  finishOutbound(id, { wamid = null, status, error = "" }) {
    this.sql.exec(`UPDATE messages SET wamid = ?, status = ?, error = ? WHERE id = ?`, wamid, status, error, id);
    if (wamid) {
      const pending = this.rows(`SELECT status, error, time FROM pending_status WHERE wamid = ?`, wamid)[0];
      if (pending) {
        this.sql.exec(`DELETE FROM pending_status WHERE wamid = ?`, wamid);
        this.applyStatus({ wamid, status: pending.status, error: pending.error, time: pending.time });
      }
    }
    return this.getMessage(id);
  }

  // ----- views -----

  chats() {
    return this.rows(
      `SELECT f.wa_id, f.name, f.title, f.reg,
              (SELECT MAX(time) FROM messages m WHERE m.wa_id = f.wa_id AND m.dir = 'in') AS last_inbound,
              (SELECT COUNT(*) FROM messages m WHERE m.wa_id = f.wa_id AND m.dir = 'in'
                 AND m.time > COALESCE((SELECT read_at FROM reads r WHERE r.wa_id = f.wa_id), 0)) AS unread,
              l.id AS last_id, l.dir AS last_dir, l.kind AS last_kind, l.original AS last_original,
              l.english AS last_english, l.time AS last_time
         FROM family f
         LEFT JOIN messages l ON l.id = (SELECT id FROM messages m WHERE m.wa_id = f.wa_id ORDER BY time DESC LIMIT 1)
        ORDER BY COALESCE(l.time, f.created_at) DESC`,
    );
  }

  thread(waId) {
    const family = this.getFamily(waId);
    if (!family) return null;
    const messages = this.rows(
      `SELECT id, dir, source, kind, original, english, notes, status, error, time
         FROM (SELECT * FROM messages WHERE wa_id = ? ORDER BY time DESC LIMIT ?) ORDER BY time ASC`,
      waId, THREAD_LIMIT,
    );
    this.sql.exec(
      `INSERT INTO reads (wa_id, read_at) VALUES (?, ?) ON CONFLICT(wa_id) DO UPDATE SET read_at = excluded.read_at`,
      waId, Date.now(),
    );
    return { family, messages, last_inbound: this.lastInbound(waId) };
  }
}

function inbox(env) {
  return env.INBOX_DO.get(env.INBOX_DO.idFromName("main"));
}

// ---------------------------------------------------------------------------
// Forwarded webhooks (from itabs-whatsapp)
// ---------------------------------------------------------------------------

export async function handleInbound(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!env.KELUARGA_FORWARD_SECRET) {
    console.error("Inbound: KELUARGA_FORWARD_SECRET is not set; forward refused.");
    return json({ error: "Not configured." }, 503);
  }
  const given = request.headers.get("x-forward-secret") ?? "";
  if (!(await passcodeMatches(given, env.KELUARGA_FORWARD_SECRET))) {
    return json({ error: "Forbidden." }, 403);
  }

  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const events = parseWebhook(payload);
  if (events.messages.length || events.echoes.length || events.statuses.length) {
    ctx.waitUntil(processEvents(env, events));
  }
  return json({
    ok: true,
    messages: events.messages.length,
    echoes: events.echoes.length,
    statuses: events.statuses.length,
  }, 200);
}

async function processEvents(env, { messages, echoes, statuses }) {
  const store = inbox(env);
  for (const s of statuses) {
    try { await store.applyStatus(s); } catch (err) { console.error("Inbound: status failed:", err?.message ?? err); }
  }
  for (const e of echoes) {
    try { await store.addEcho(e); } catch (err) { console.error("Inbound: echo failed:", err?.message ?? err); }
  }
  await Promise.all(messages.map(async (m) => {
    try {
      const { stored, family } = await store.addInbound(m);
      if (!stored) return; // not family, or a duplicate delivery
      if (m.kind !== "reaction" && m.original) await translateAndSave(env, store, m.id, m.original, family);
    } catch (err) {
      console.error("Inbound: message failed:", err?.message ?? err);
    }
  }));
}

async function translateAndSave(env, store, id, text, family) {
  try {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
    const result = await translate(env, {
      text: text.slice(0, MAX_INPUT_CHARS),
      direction: "id-en",
      register: family.reg,
      title: family.title || family.name,
    });
    await store.setTranslation(id, { english: result.translation, notes: result.notes });
    return true;
  } catch (err) {
    console.error(`Inbound: translation failed for ${id}:`, err?.message ?? err);
    await store.setTranslation(id, { error: "Translation failed." });
    return false;
  }
}

// Pulls messages, echoes and statuses out of Meta's webhook shape:
// { entry: [ { changes: [ { field, value: { contacts, messages, statuses, message_echoes } } ] } ] }
export function parseWebhook(payload) {
  const out = { messages: [], echoes: [], statuses: [] };
  for (const entry of asArray(payload?.entry)) {
    for (const change of asArray(entry?.changes)) {
      const value = change?.value ?? {};
      for (const msg of asArray(value.messages)) {
        const waId = digits(msg?.from);
        if (!waId || !msg?.id) continue;
        out.messages.push({ id: String(msg.id), wa_id: waId, time: toMs(msg.timestamp), ...describe(msg) });
      }
      for (const msg of asArray(value.message_echoes)) {
        const waId = digits(msg?.to);
        if (!waId || !msg?.id) continue;
        out.echoes.push({ id: String(msg.id), wa_id: waId, time: toMs(msg.timestamp), ...describe(msg) });
      }
      for (const s of asArray(value.statuses)) {
        if (!s?.id || typeof s.status !== "string") continue;
        const err = asArray(s.errors)[0];
        out.statuses.push({
          wamid: String(s.id),
          status: s.status,
          error: err ? String(err.error_data?.details || err.message || err.title || "").slice(0, 300) : "",
          time: toMs(s.timestamp),
        });
      }
    }
  }
  return out;
}

// kind + the text worth showing/translating for each message type.
function describe(msg) {
  const type = String(msg?.type ?? "other");
  const caption = (o) => (typeof o?.caption === "string" ? o.caption : "");
  let kind = type;
  let text = "";
  switch (type) {
    case "text": text = msg.text?.body ?? ""; break;
    case "image": case "video": case "document": text = caption(msg[type]); break;
    case "audio": case "sticker": break;
    case "reaction": text = msg.reaction?.emoji ?? ""; break;
    case "location": text = [msg.location?.name, msg.location?.address].filter(Boolean).join(", "); break;
    case "button": kind = "text"; text = msg.button?.text ?? ""; break;
    case "interactive":
      kind = "text";
      text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? "";
      break;
    default: kind = "other";
  }
  return { kind, original: String(text).trim().slice(0, MAX_WA_TEXT) };
}

// ---------------------------------------------------------------------------
// Inbox API (PIN-protected)
// ---------------------------------------------------------------------------

export async function handleInboxApi(request, env, ctx, url) {
  const path = url.pathname.slice("/api/inbox/".length);
  const method = request.method;

  // POSTs must come from this site's own pages (on top of the SameSite cookie).
  if (method === "POST" && request.headers.get("Origin") !== url.origin) {
    return noStore(json({ error: "Not allowed." }, 403));
  }
  if (method !== "GET" && method !== "POST") return noStore(json({ error: "Method not allowed." }, 405));

  try {
    if (path === "session" && method === "GET") {
      return noStore(json({ signed_in: await hasSession(request, env), configured: pinConfigured(env) }, 200));
    }
    if (path === "login" && method === "POST") return noStore(await login(request, env));
    if (path === "logout" && method === "POST") {
      return noStore(json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/api/inbox; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }));
    }

    if (!(await hasSession(request, env))) {
      return noStore(json({ error: "Please enter your PIN.", code: "signed_out" }, 401));
    }

    const store = inbox(env);
    const body = method === "POST" ? await readJson(request) : null;
    if (method === "POST" && body === null) return noStore(json({ error: "Body must be JSON." }, 400));

    if (path === "chats" && method === "GET") {
      return noStore(json({ now: Date.now(), chats: await store.chats() }, 200));
    }

    if (path === "thread" && method === "GET") {
      const waId = digits(url.searchParams.get("wa_id"));
      const thread = waId ? await store.thread(waId) : null;
      if (!thread) return noStore(json({ error: "That chat isn't on your family list." }, 404));
      return noStore(json({ now: Date.now(), ...thread }, 200));
    }

    if (path === "family" && method === "POST") {
      const waId = normalizeNumber(body.wa_id);
      const name = cleanText(body.name, 60);
      if (!waId) return noStore(json({ error: "Enter a WhatsApp number with its country code, e.g. +62 812 3456 7890." }, 400));
      if (!name) return noStore(json({ error: "Enter a name." }, 400));
      const family = await store.upsertFamily({
        wa_id: waId,
        name,
        title: cleanText(body.title, 40),
        reg: REGISTERS.has(body.reg) ? body.reg : "polite",
      });
      return noStore(json({ family }, 200));
    }

    if (path === "family/remove" && method === "POST") {
      const waId = digits(body.wa_id);
      if (!waId) return noStore(json({ error: "Missing number." }, 400));
      await store.removeFamily(waId);
      return noStore(json({ ok: true }, 200));
    }

    if (path === "preview" && method === "POST") return noStore(await preview(request, env, store, body));
    if (path === "send" && method === "POST") return noStore(await send(env, store, body));

    if (path === "retranslate" && method === "POST") {
      const msg = typeof body.id === "string" ? await store.getMessage(body.id) : null;
      if (!msg || msg.dir !== "in" || !msg.original) return noStore(json({ error: "Nothing to translate." }, 404));
      const family = await store.getFamily(msg.wa_id);
      if (!family) return noStore(json({ error: "That chat isn't on your family list." }, 404));
      if (!(await underRateLimit(request, env))) return noStore(json({ error: "Too many translations. Wait a minute." }, 429));
      await translateAndSave(env, store, msg.id, msg.original, family);
      return noStore(json({ message: await store.getMessage(msg.id) }, 200));
    }

    return noStore(json({ error: "Not found." }, 404));
  } catch (err) {
    return noStore(errorResponse(err));
  }
}

async function preview(request, env, store, body) {
  const waId = digits(body.wa_id);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Type your reply first." }, 400);
  if (text.length > MAX_INPUT_CHARS) return json({ error: `Replies are limited to ${MAX_INPUT_CHARS} characters.` }, 400);
  const family = waId ? await store.getFamily(waId) : null;
  if (!family) return json({ error: "That chat isn't on your family list." }, 404);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set on the Worker." }, 500);
  if (!(await underRateLimit(request, env))) return json({ error: "Too many translations. Wait a minute." }, 429);
  const result = await translate(env, {
    text,
    direction: "en-id",
    register: family.reg,
    title: family.title || family.name,
  });
  return json({ ...result, last_inbound: await store.lastInbound(waId), now: Date.now() }, 200);
}

async function send(env, store, body) {
  const waId = digits(body.wa_id);
  const clientId = typeof body.client_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.client_id) ? body.client_id : "";
  const indonesian = typeof body.indonesian === "string" ? body.indonesian.trim() : "";
  const english = typeof body.english === "string" ? body.english.trim().slice(0, MAX_INPUT_CHARS) : "";
  if (!waId || !clientId || !indonesian) return json({ error: "Preview your reply before sending." }, 400);
  if (indonesian.length > MAX_WA_TEXT) return json({ error: "That message is too long for WhatsApp." }, 400);
  if (!env.DUALHOOK_API_KEY || !env.DUALHOOK_PHONE_NUMBER_ID || !env.DUALHOOK_API_BASE) {
    return json({ error: "Sending isn't set up: DUALHOOK_API_KEY is missing on the Worker." }, 500);
  }

  const now = Date.now();
  const r = await store.reserveOutbound({ client_id: clientId, wa_id: waId, original: indonesian, english, now });
  if (r.existing) return json({ message: r.existing, duplicate: true }, 200);
  if (r.error === "not_family") return json({ error: "That chat isn't on your family list." }, 404);
  if (r.error === "window_closed") {
    return json({
      error: "It's been more than 24 hours since their last message, so WhatsApp won't accept a reply from here. Copy the Indonesian and send it from the WhatsApp Business app.",
      code: "window_closed",
      last_inbound: r.last_inbound,
    }, 409);
  }

  const id = r.message.id;
  let res, data;
  try {
    res = await fetch(`${env.DUALHOOK_API_BASE.replace(/\/+$/, "")}/${env.DUALHOOK_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DUALHOOK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: waId,
        type: "text",
        text: { preview_url: false, body: indonesian },
      }),
      signal: AbortSignal.timeout(15000),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    console.error("Send: Dualhook request failed:", err?.message ?? err);
    const message = await store.finishOutbound(id, {
      status: "failed",
      error: "No answer from Dualhook. Check WhatsApp before trying again, in case it did go through.",
    });
    return json({ message, error: message.error }, 502);
  }

  const wamid = data?.messages?.[0]?.id;
  if (res.ok && wamid) {
    const message = await store.finishOutbound(id, { wamid: String(wamid), status: "accepted" });
    return json({ message }, 200);
  }

  const apiErr = data?.error ?? {};
  console.error("Send: Dualhook error", res.status, JSON.stringify(apiErr).slice(0, 500));
  const reason = apiErr.code === 131047
    ? "WhatsApp says the 24-hour reply window has closed. Send it from the WhatsApp Business app instead."
    : `WhatsApp didn't accept it: ${String(apiErr.error_data?.details || apiErr.message || "HTTP " + res.status).slice(0, 200)}`;
  const message = await store.finishOutbound(id, { status: "failed", error: reason });
  return json({ message, error: reason }, 502);
}

// ----- PIN sessions -----

function pinConfigured(env) {
  return typeof env.INBOX_PIN === "string" && env.INBOX_PIN.length >= MIN_PIN_LENGTH;
}

async function login(request, env) {
  if (!pinConfigured(env)) {
    return json({ error: `The inbox PIN isn't set up. Add an INBOX_PIN secret (at least ${MIN_PIN_LENGTH} characters) to the Worker.` }, 503);
  }
  if (env.PIN_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.PIN_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "Too many tries. Wait a minute and try again." }, 429);
  }
  const body = await readJson(request);
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!(await passcodeMatches(pin, env.INBOX_PIN))) return json({ error: "Wrong PIN." }, 401);

  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const token = `${exp}.${await sign(env, String(exp))}`;
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=${token}; Path=/api/inbox; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  });
}

async function hasSession(request, env) {
  if (!pinConfigured(env)) return false;
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([0-9a-f]{64})`));
  if (!match) return false;
  const exp = Number(match[1]);
  if (!(exp > Date.now() / 1000)) return false;
  return passcodeMatches(match[2], await sign(env, match[1]));
}

// HMAC keyed by the PIN plus the forward secret: changing either signs
// everyone out.
async function sign(env, value) {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest("SHA-256", enc.encode(`kc-inbox|${env.INBOX_PIN}|${env.KELUARGA_FORWARD_SECRET ?? ""}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode("session:" + value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ----- helpers -----

async function underRateLimit(request, env) {
  if (!env.RATE_LIMITER) return true;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  return success;
}

async function readJson(request) {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function noStore(response) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function digits(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : "";
}

// International format as WhatsApp uses it. "08..." is an Indonesian mobile
// number, so it becomes "628...".
function normalizeNumber(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("08")) d = "62" + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : "";
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function toMs(timestamp) {
  const s = Number(timestamp);
  return Number.isFinite(s) && s > 0 ? s * 1000 : Date.now();
}
