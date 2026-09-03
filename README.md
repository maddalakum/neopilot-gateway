# NeoPilot secure gateway

This folder is intentionally separate from `neopilot-dashboard`. The GitHub Pages folder must never contain a GitHub PAT, Kotak SID/Auth values, owner key, or access-signing secret.

## Cloudflare architecture

The GitHub Pages dashboard calls this Worker. The Worker calls GitHub and Kotak server-to-server, returns normalized account data, proxies sanitized order/position WebSocket events, and restricts access to `https://maddalakum.github.io`.

Tampermonkey stores only the Worker URL and `OWNER_KEY`. The private GitHub PAT and Kotak session files never enter the generated access URL or the trader's browser.

## Required Cloudflare secrets

Edit `.dev.vars` locally. It is ignored by Git and must never be uploaded.

Required values:

- `GITHUB_PAT`: a new fine-grained, read-only token for `maddalakum/Suploads`.
- `OWNER_KEY`: a long private value also stored in the owner's Tampermonkey configuration.
- `ACCESS_SIGNING_SECRET`: at least 32 random characters used by the gateway to sign daily links.

The gateway currently provides:

- `GET /health`: reports only whether each secret is configured; never returns secret values.
- `POST /owner/access-link`: requires `Authorization: Bearer OWNER_KEY` and returns a link valid for the current India date.
- `POST /session/verify`: verifies a daily access token.
- `POST /api/bootstrap`: validates configured account roles without returning raw credentials.
- `POST /api/snapshot`: loads normalized funds, positions, holdings, and orders.
- `POST /api/positions`: provides the live position refresh.
- `POST /api/details`: refreshes funds, holdings, and orders.
- `POST /api/signal`: resolves the nearest-upcoming SENSEX/NIFTY option contract; LTP remains paused.
- `POST /api/order/place`: revalidates and submits a guarded live entry order through the trade-role file.
- `POST /api/stream/ticket`: creates a short-lived WebSocket ticket.
- `GET /api/stream`: proxies only sanitized Kotak order/position events; SID/Auth values stay in the Worker.

Set each with `wrangler secret put SECRET_NAME`; never place them in `wrangler.jsonc`.

## Deploy

1. Run `npx wrangler login`.
2. Run `npx wrangler secret put GITHUB_PAT` and enter a new fine-grained, read-only token for `maddalakum/Suploads`.
3. Run `npx wrangler secret put OWNER_KEY` and enter a unique value of at least 24 characters.
4. Run `npx wrangler secret put ACCESS_SIGNING_SECRET` and enter an independent random value of at least 32 characters.
5. Run `npx wrangler deploy`.
6. In Tampermonkey, configure the returned `workers.dev` address and the same `OWNER_KEY`.

## Local use

1. Run `npm run dev` in this folder.
2. Open `http://127.0.0.1:4173/#owner`.
3. Configure Tampermonkey with `http://127.0.0.1:8787` and the same local `OWNER_KEY`, then generate the link.

Edit `accounts.config.js` to add account pairs in `tradeFileEndingNeo.txt|readFileStartingNeo.txt` format.

Live entry placement is enabled by `LIVE_TRADING_ENABLED=true`. Managed profit exits and live manual exits remain disabled. The order stream uses the read-role SID/Auth handshake, while order placement uses the trade-role SID/Auth/consumer key.
