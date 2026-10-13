# nicolescheid.com

Personal site for [nicolescheid.com](https://nicolescheid.com). A lightweight static
placeholder for now, served by a **Cloudflare Worker** (Workers Static Assets),
auto-deployed from this repo on every push.

## Edit & deploy

The site is `public/index.html` — no build step. Edit it and `git push`;
Cloudflare runs `npx wrangler deploy` (per `wrangler.jsonc`) and serves
everything in `public/`.

- Site files: `public/`
- Config: `wrangler.jsonc`

## Homepage redirect

`public/_redirects` sends `/` to `/ai-cv` (302), so the AI CV is what visitors get at
nicolescheid.com. `index.html` stays in the repo as the fallback landing page: delete the
rules in `_redirects` to bring it back.
