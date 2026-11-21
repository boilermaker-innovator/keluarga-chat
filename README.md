# Keluarga Chat (Family Chat)

A small, private translator for writing to family in Indonesia: English ⇄ Bahasa Indonesia, polite forms for elders, and one-tap send to WhatsApp.

Live at **https://keluarga-chat-worker.jgwynne7.workers.dev**

Deployed via Cloudflare Workers Builds

```
                    one Cloudflare Worker: keluarga-chat-worker
your phone ──▶  /              → site/index.html (static files)
           ──▶  /api/translate → worker/src/index.js ──▶ Anthropic API
                                 (holds the API key as a secret)
```

- **`wrangler.toml`** (repo root) configures one Worker that does both jobs: it serves `site/` as static files and runs `worker/src/index.js` for anything under `/api/`.
- **`site/index.html`** is one plain HTML file with no build step. It calls its own `/api/translate`, so there's no Worker address to type in, and it never sees the API key.
- **`worker/src/index.js`** checks the family passcode, then calls Claude through the Anthropic API using a key stored as an encrypted Worker secret.

## What it does

- **Two directions.** English → Indonesian to write to family; Indonesian → English to understand a message you received (texting abbreviations like *gpp*, *otw* and *udh*, plus Javanese words, are expanded and explained).
- **Family contacts.** Name, relationship, what you call them, default politeness and WhatsApp number. They're stored only in your browser on that device (`localStorage`); export and import a JSON file to move them.
- **Polite forms for elders.** Three registers:
  - **Formal** for grandparents and in-laws: addresses them by title instead of *kamu* (*"Eyang sudah makan?"*), uses *mohon*, *silakan* and *terima kasih banyak*, and no slang.
  - **Polite** for parents, aunts and uncles, and older siblings: respectful but warm, still uses their title.
  - **Casual** for younger siblings, cousins and friends: everyday *aku/kamu*.
  
  Each relationship sets a default, and you can switch it per message.
- **Relationships included.** Kakek, Nenek, Eyang, Mbah, Opa, Oma, Ibu/Bapak mertua, Ibu, Bapak, Tante, Om, Mbak, Mas, Kak, Adik, Sepupu, Teman and Other. "What you call them" can be anything (*Eyang Putri*, *Mama*, *Pakde*).
- **Reply suggestions.** When you translate a family message into English, 2–3 short replies appear. Tap one and it's put in the English box, with the same person selected, ready to edit and translate.
- **Tone check.** When you write in English, a warning appears if the message could sound rude, too blunt or too casual for that person (especially elders), with a gentler version already translated. "Use gentler version" swaps it in; "Keep mine" dismisses the warning.
- **Check-back line.** Every English → Indonesian result also comes back translated into English, so you can confirm what you're about to send.
- **One-tap WhatsApp.** "Send to Eyang Putri on WhatsApp" opens `wa.me/<number>?text=…` with the message filled in. You still tap send in WhatsApp. Numbers starting `08` are treated as Indonesian and converted to `+62`.

## Security model

| Concern | How it's handled |
|---|---|
| API key exposure | The key is only a Worker secret (`wrangler secret put`). It's never in the page, the repo or the browser. |
| Strangers using your credit | A **family passcode** (also a Worker secret) is required on every request and compared in constant time. The page remembers it on your device. |
| Other websites calling the Worker | **Origin check**: only the Worker's own address and the origins in `ALLOWED_ORIGINS` get a response. |
| Floods or runaway cost | **20 requests a minute per IP** (Cloudflare rate-limit binding) and a **2,000-character** cap per message. |
| Prompt injection in messages | The message is wrapped in `<message>` tags and the model is told to translate it, never follow it. Output is constrained to a JSON schema. |
| Contacts' privacy | Phone numbers stay in your browser. The Worker receives only the message text, direction, register and the title (e.g. "Eyang"), not names or numbers. |

The Worker uses the model `claude-opus-5-5` at **low effort**, which suits short chat messages. It also uses Anthropic's **server-side fallback** (`fallbacks: "default"`): if a safety classifier declines a message, the request is re-run on Anthropic's recommended fallback model instead of failing.

## Setup

You need a Cloudflare account, an Anthropic API key (console.anthropic.com) and Node.js 18 or later. Everything runs from the **repo root**.

### Option A: Cloudflare deploys from GitHub (current setup)

The Worker `keluarga-chat-worker` is connected to this repo, so each push to `main` deploys it. Cloudflare reads `wrangler.toml` at the repo root, installs `package.json`, and runs `npx wrangler deploy`. In the dashboard (Workers & Pages → keluarga-chat-worker → Settings → Build), the build settings should be:

- **Root directory:** `/` (empty)
- **Build command:** empty
- **Deploy command:** `npx wrangler deploy`

Add the two secrets once, under Workers & Pages → keluarga-chat-worker → Settings → Variables and Secrets, as type **Secret**:

- `ANTHROPIC_API_KEY`: your Anthropic API key
- `FAMILY_PASSCODE`: the family passcode

Or from a terminal:

```bash
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put FAMILY_PASSCODE
```

### Option B: deploy by hand

```bash
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # first time only
npx wrangler secret put FAMILY_PASSCODE     # first time only
npx wrangler deploy
```

### Using it

Open https://keluarga-chat-worker.jgwynne7.workers.dev on your phone. Under **Settings**, enter the family passcode and tap **Save settings**. Add your family under **Family contacts**. On iPhone, Share → *Add to Home Screen* makes it feel like an app.

If you add a custom domain, the Worker accepts requests from its own address automatically. Add a domain to `ALLOWED_ORIGINS` in `wrangler.toml` only when a page on a *different* address needs to call the API.

### Local development

```bash
cp .dev.vars.example .dev.vars    # fill in a real key and a passcode; .dev.vars is git-ignored
npx wrangler dev                  # page and API on http://localhost:8787
```

## Worker API

`POST /api/translate`

Headers: `Content-Type: application/json`, `X-Family-Passcode: <passcode>`

```json
{ "text": "Hi Eyang, how are you?", "direction": "en-id", "register": "formal", "title": "Eyang" }
```

- `direction`: `en-id` or `id-en`.
- `register`: `formal`, `polite` or `casual`.
- `title`: what you call the person (who you're writing to, or who the message is from).

Response:

```json
{
  "translation": "Eyang, kirim fotonya sekarang.",
  "back_translation": "Eyang, send the photo now.",
  "notes": "",
  "reply_suggestions": [],
  "tone_check": {
    "ok": false,
    "issue": "Sounds like an order, which can feel disrespectful to an elder.",
    "gentler_english": "Eyang, when you have a moment, could you please send the photo?",
    "gentler_translation": "Eyang, kalau sempat, boleh tolong kirim fotonya?",
    "gentler_back_translation": "Eyang, if you have time, could you please send the photo?"
  }
}
```

`reply_suggestions` (up to 3) is filled only for `id-en`; `tone_check` is only ever not-ok for `en-id`. Both come from the same single Claude call as the translation.

Errors come back as `{ "error": "<friendly message>" }` with these status codes: 400 (bad input), 401 (wrong passcode), 403 (origin not allowed), 422 (declined), 429 (rate limited), and 502/503 (upstream problems).

## WhatsApp inbox

Open **/inbox** (PIN-protected): one chat per relative, their WhatsApp message with the English underneath, and replies you write in English, preview in Indonesian (with the tone check) and send only when you tap **Send**.

```
Meta → Dualhook → itabs-whatsapp  (GET verification; logs; replies 200 at once)
                       │ background copy, header x-forward-secret
                       ▼
          keluarga-chat-worker  POST /api/whatsapp/inbound
            • family-only: everyone else is ignored (not stored, not translated)
            • translates to English, stores in the InboxStore Durable Object (SQLite)
          /inbox page → /api/inbox/* (PIN cookie) → Send → Dualhook API → WhatsApp
```

- **Nothing is sent automatically.** The only code path that calls Dualhook is `POST /api/inbox/send`, which the page calls when you tap Send. A double tap can't send twice (each preview has its own id).
- **24-hour rule.** Send works only within 24 hours (minus 2 minutes) of the relative's last message; otherwise the API refuses and the page offers **Copy Indonesian** + **Open WhatsApp** so you can send from the Business app.
- **Stored per message:** original, English, notes, delivery status (✓ sent, ✓✓ delivered, ✓✓ read, or the failure reason). Messages you send from the Business app appear as "Sent from your phone" when Dualhook passes on `smb_message_echoes`. Photos, voice notes and videos show a placeholder (captions are translated).
- **Removing a relative** deletes their saved messages from the inbox (WhatsApp itself isn't affected).

### Inbox setup

On **keluarga-chat-worker** (Workers & Pages → keluarga-chat-worker → Settings → Variables and Secrets, type **Secret**):

| Secret | Value |
|---|---|
| `KELUARGA_FORWARD_SECRET` | the same value as on itabs-whatsapp |
| `DUALHOOK_API_KEY` | the same key as on itabs-whatsapp |
| `INBOX_PIN` | your PIN, at least 6 characters |

`DUALHOOK_API_BASE` and `DUALHOOK_PHONE_NUMBER_ID` are plain vars in `wrangler.toml`. The Durable Object is created automatically on deploy.

On **itabs-whatsapp**: its POST handler forwards each webhook body to `https://keluarga-chat-worker.jgwynne7.workers.dev/api/whatsapp/inbound` in `ctx.waitUntil`, with header `x-forward-secret: <KELUARGA_FORWARD_SECRET>`, and always returns 200 to Meta.

### Inbox API

All under `/api/inbox/`, same-origin only; everything except `session` and `login` needs the PIN cookie.

| Endpoint | Does |
|---|---|
| `GET session` | `{ signed_in, configured }` |
| `POST login` `{ pin }` / `POST logout` | sets / clears a 30-day HttpOnly cookie (5 PIN tries a minute per IP) |
| `GET chats` | family list with last message, unread count and `last_inbound` |
| `GET thread?wa_id=` | one relative's messages (marks them read) |
| `POST family` `{ wa_id, name, title, reg }` / `POST family/remove` `{ wa_id }` | manage the family list |
| `POST preview` `{ wa_id, text }` | English → Indonesian with tone check (no sending) |
| `POST send` `{ wa_id, client_id, indonesian, english }` | sends through Dualhook; 409 `window_closed` past 24 hours |
| `POST retranslate` `{ id }` | retries a failed translation |

## Roadmap

- [x] Translator page with contacts, registers, check-back line and WhatsApp send
- [x] Worker with secret key, passcode, CORS allowlist, rate limit and size cap
- [x] Reply suggestions and tone check
- [x] WhatsApp inbox: family messages translated, replies previewed and sent on tap, 24-hour rule, PIN
- [ ] Saved phrases (e.g. *Selamat Idul Fitri, mohon maaf lahir dan batin*) and greetings for Lebaran, birthdays and Natal
- [ ] Recent translations history (on-device)
- [ ] Voice input on mobile
- [ ] Bahasa Indonesia interface, so family members can use it too
- [ ] Optional regional flavour (Javanese *krama* touches for Eyang and Mbah)
