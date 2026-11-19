# Put talk.itabs.co on Cloudflare

This folder (`talk-itabs/`) is the whole site. Plain files, no build step.

## A. Create the site (Cloudflare Pages)
1. Log in at dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** tab.
2. Choose **Connect to Git** → pick `boilermaker-innovator/keluarga-chat`.
3. Settings:
   - Project name: `talk-itabs`
   - Production branch: the branch this folder is on (`main` once merged)
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `talk-itabs`
4. **Save and Deploy**. You get a test address like `talk-itabs.pages.dev`.
   Check `https://talk-itabs.pages.dev/aidan` and try all three buttons.

   *No Git? Use **Upload assets** instead and drag in the `talk-itabs` folder.*

## B. Point talk.itabs.co at it
5. In the `talk-itabs` Pages project → **Custom domains** → **Set up a custom domain**.
6. Type `talk.itabs.co` → **Continue**.
7. Then one of:
   - **itabs.co's DNS is already on Cloudflare:** click **Activate domain**. Cloudflare adds the DNS record for you. Done.
   - **itabs.co's DNS is elsewhere (e.g. GoDaddy, Crazy Domains):** log in there and add a record:
     `Type: CNAME · Name: talk · Value: talk-itabs.pages.dev`. Then come back and click **Check DNS**.
8. Wait for the status to say **Active** (usually minutes, can be up to a day). HTTPS is automatic.
9. Open `https://talk.itabs.co/aidan` on your phone, and scan the QR code to test it.

## Adding the next talk
Copy the `aidan` folder to a new name (e.g. `sarah`), swap the MD, title and QR, push. It goes live at `talk.itabs.co/sarah`.
