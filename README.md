# Keluarga Chat (Family Chat)

A small, private translator for writing to family in Indonesia: English ⇄ Bahasa Indonesia, polite forms for elders, and one-tap send to WhatsApp.

```
site/index.html  (your phone)  ──POST /translate──▶  Cloudflare Worker  ──▶  Anthropic API
  contacts, UI, WhatsApp button                        holds the API key
  (Cloudflare Pages)                                   (Worker secret)
```

- **`site/index.html`** is one plain HTML file with no build step, hosted on Cloudflare Pages. It knows only the Worker's address and never sees the API key.
- **`worker/`** is a small Cloudflare Worker. It checks the family passcode, then calls Claude through the Anthropic API using a key stored as an encrypted Worker secret.

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
| Other websites calling the Worker | **CORS allowlist** (`ALLOWED_ORIGINS`): only your Pages site gets a browser response. |
| Floods or runaway cost | **20 requests a minute per IP** (Cloudflare rate-limit binding) and a **2,000-character** cap per message. |
| Prompt injection in messages | The message is wrapped in `<message>` tags and the model is told to translate it, never follow it. Output is constrained to a JSON schema. |
| Contacts' privacy | Phone numbers stay in your browser. The Worker receives only the message text, direction, register and the title (e.g. "Eyang"), not names or numbers. |

The Worker uses the model `claude-opus-5-5` at **low effort**, which suits short chat messages. It also uses Anthropic's **server-side fallback** (`fallbacks: "default"`): if a safety classifier declines a message, the request is re-run on Anthropic's recommended fallback model instead of failing.

## Setup

You need a Cloudflare account, an Anthropic API key (console.anthropic.com) and Node.js 18 or later.

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login

# Secrets: you'll be prompted to paste each value. They're never written to disk.
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put FAMILY_PASSCODE

npx wrangler deploy
```

Note the URL it prints, e.g. `https://keluarga-chat-api.<your-subdomain>.workers.dev`.

### 2. Deploy the page to Cloudflare Pages

```bash
cd ..   # repo root
npx wrangler pages deploy site --project-name keluarga-chat
```

On the first run it creates the project. Your page is then at `https://keluarga-chat.pages.dev`. If that name is taken, use another name and note the URL. You can also connect this GitHub repo in the Cloudflare dashboard (Workers & Pages → Create → Pages → Connect to Git) with **build command: none** and **output directory: `site`**, so every push deploys.

### 3. Allow the page to call the Worker

In `worker/wrangler.toml`, set `ALLOWED_ORIGINS` to your Pages URL, plus any custom domain, comma-separated with no trailing slash. Then redeploy:

```bash
cd worker && npx wrangler deploy
```

### 4. Open the page and connect it

Open the Pages URL on your phone. Under **Settings**, enter the Worker URL and the family passcode, then tap **Save settings**. Add your family under **Family contacts**. On iPhone, Share → *Add to Home Screen* makes it feel like an app.

Optional: put the Worker URL in `DEFAULT_WORKER_URL` near the top of the script in `site/index.html` and redeploy. Then a new device only needs the passcode.

### Local development

```bash
cd worker
cp .dev.vars.example .dev.vars    # fill in a real key and a passcode; .dev.vars is git-ignored
npx wrangler dev                  # Worker on http://localhost:8787

# in another terminal, from the repo root
python3 -m http.server 8788 --directory site   # page on http://localhost:8788
```

In the page's Settings, use `http://localhost:8787` as the Worker URL.

## Worker API

`POST /translate`

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
