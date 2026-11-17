# LeadBox Studio — Cloudflare Workers

This folder is a **new webhook-based bot backend**, not yet a feature-for-feature port of the old Python bot. It stores new leads in D1 and sends administrator notifications. Existing SQLite data, analytics, export, and other bot features require a separate migration after the original bot source is available.

## Deployment

1. Sign in to Cloudflare and install Node.js 20 or newer.
2. From this folder run: `npx wrangler login`
3. Create database: `npx wrangler d1 create leadbox-studio`
4. Copy the returned database ID into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).
5. Initialize the remote database: `npx wrangler d1 execute leadbox-studio --remote --file=./schema.sql`
6. Set secrets, one command at a time:
   - `npx wrangler secret put BOT_TOKEN` (existing Telegram BotFather token)
   - `npx wrangler secret put WEBHOOK_SECRET` (random 16–256 letters/digits/underscores/hyphens)
   - `npx wrangler secret put ADMIN_CHAT_ID` (numeric administrator chat ID)
7. Optional: add `MINI_APP_URL` as a regular environment variable pointing to an existing HTTPS Mini App.
8. Run `npx wrangler deploy`. Save the full `https://...workers.dev` URL.
9. Verify `https://YOUR_WORKER_URL/health` returns a JSON status.
10. Only after successful deployment and D1 setup, configure the Telegram webhook:

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_WORKER_URL/telegram/webhook","secret_token":"YOUR_WEBHOOK_SECRET","allowed_updates":["message","callback_query"]}'
```

11. Verify the webhook with `https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo` and test the full application flow (`/start` → project type → description → contact → administrator notification).

## Important

- The current original bot source was **not** found in the root of the connected GitHub repository, so this is a fresh Cloudflare-compatible implementation, not a guarantee of parity.
- The same Telegram bot token cannot simultaneously receive updates via polling and a webhook. Keep the old deployment intact until ready to switch.
- Never commit BOT_TOKEN or WEBHOOK_SECRET.
- A Cloudflare Worker is request-driven, rather than a permanent Python process. This is normal and avoids idle-instance sleep.
- D1 is persistent; local Worker disk files are not. To retain historical leads, plan an explicit SQLite-to-D1 import.
- For export, status management, a richer admin panel, and Mini App API integration, compare against the original code before production cutover.
- In production monitor Cloudflare logs and Telegram getWebhookInfo for failed updates.


Cloudflare Git integration: production builds are triggered by commits to `main`; Worker `leadbox-studio-v1`. Configure `BOT_TOKEN`, `WEBHOOK_SECRET`, and `ADMIN_CHAT_ID` as secrets before enabling the Telegram webhook.
