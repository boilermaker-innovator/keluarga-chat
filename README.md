# Keluarga Chat (Family Chat)

A small, private translator for writing to family in Indonesia: English ⇄ Bahasa Indonesia, polite forms for elders, and one-tap send to WhatsApp.

Live at **https://keluarga-chat-worker.jgwynne7.workers.dev**

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
- `register`: `formal`, `polite` or `casual` (used for `en-id`).
- `title`: what you call the person (used for `en-id`).

Response:

```json
{ "translation": "Eyang, apa kabar?", "back_translation": "Eyang, how are you?", "notes": "" }
```

Errors come back as `{ "error": "<friendly message>" }` with these status codes: 400 (bad input), 401 (wrong passcode), 403 (origin not allowed), 422 (declined), 429 (rate limited), and 502/503 (upstream problems).

## Roadmap

- [x] Translator page with contacts, registers, check-back line and WhatsApp send
- [x] Worker with secret key, passcode, CORS allowlist, rate limit and size cap
- [ ] Saved phrases (e.g. *Selamat Idul Fitri, mohon maaf lahir dan batin*) and greetings for Lebaran, birthdays and Natal
- [ ] Recent translations history (on-device)
- [ ] Voice input on mobile
- [ ] Bahasa Indonesia interface, so family members can use it too
- [ ] Optional regional flavour (Javanese *krama* touches for Eyang and Mbah)
