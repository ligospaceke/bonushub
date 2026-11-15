# Deploy BonasHub v2 to Cloudflare Workers (staging, to review the UI/UX)

Needs Node 20+ and a free Cloudflare account. Run everything from the project folder.

1. Install and sign in
   npm install
   npx wrangler login

2. Create the database. Copy the `database_id` it prints into wrangler.toml (replace REPLACE_WITH_D1_DATABASE_ID).
   npx wrangler d1 create bonashub

3. Create the tables on the remote database
   npx wrangler d1 migrations apply bonashub --remote

4. Load the demo data (fake sellers, products, one buyer, one owner). Staging only.
   npx wrangler d1 execute bonashub --remote --file=seed-demo.sql

5. Set the one secret the payment sandbox needs (any long random string)
   npx wrangler secret put PAYMENT_WEBHOOK_SECRET

6. Deploy
   npx wrangler deploy
   The URL is printed: https://bonas-hub-v2.<your-subdomain>.workers.dev

Demo sign-ins (password Demo-pass-12345):
   owner@bonashub.local (admin) · rift@demo.local, savanna@demo.local, build@demo.local (sellers) · buyer@demo.local (buyer)

Staging notes
- wrangler.toml has SANDBOX_ENABLED="true", so checkout shows the practice "Approve payment" buttons. No real money moves.
- Email and SMS are not connected, so verification codes are not delivered. "Skip for now" on the verify page works.
- Update after a code change: `npx wrangler deploy`. Reset data: delete the D1 database, repeat steps 2-4.
- Before real users: set SANDBOX_ENABLED="false", remove seed data and demo accounts, create your own owner with `scripts/create-admin.js` logic (see README), connect a licensed payment provider, and add a custom domain.

## Automatic deploys with GitHub Actions (no Termux, no local wrangler)

Every push to `main` runs the tests, applies D1 migrations and deploys the Worker from GitHub's servers, so your phone's network no longer matters.

One-time setup (all in a browser):
1. **Create the D1 database** in the Cloudflare dashboard: Storage & Databases > D1 > Create, name it `bonashub`. Copy its Database ID into `wrangler.toml` (replace `REPLACE_WITH_D1_DATABASE_ID`). The ID is not a secret.
2. **Create an API token**: Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers" template, then add the permission *Account > D1 > Edit*. Copy the token.
3. **Find your Account ID**: Workers & Pages overview, right-hand side.
4. **Add GitHub secrets**: repository > Settings > Secrets and variables > Actions > New repository secret:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `PAYMENT_WEBHOOK_SECRET` (any long random string)
5. Push the project to GitHub (`git init`, `git add .`, `git commit`, `git branch -M main`, add the remote, `git push -u origin main`). The *Actions* tab shows the run.
6. First time only: Actions > "Deploy to Cloudflare Workers" > Run workflow > tick **Load the demo products**.

After that, just `git push` (or edit files on github.com) and the site updates in about a minute.
