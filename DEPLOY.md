# Charleston CRM — deployment runbook

## What this is
A fork of the working studio CRM, turned into a paywalled SaaS:
- Open self-serve signup (`/signup`) — each signup is a studio **owner**.
- Stripe subscription **$9.99/mo** (`/subscribe` → Stripe Checkout).
- Paywall gate: `/dashboard`, `/students`, `/schedule`, `/inquiries`, `/settings`,
  `/profile`, `/card` require sign-in **and** an active subscription.
- Webhook `/api/stripe/webhook` keeps Stripe → Supabase (`accounts.subscription_status`) in sync.
- `/account` — manage or cancel via Stripe billing portal.

## Deploy steps
1. **Supabase**: new project → run `subscription-schema.sql` (plus the base schemas from the app).
2. **Stripe (test)**: create product "Charleston CRM", price $9.99/mo recurring → copy the price id.
   Add webhook → `https://charlestoncrm.com/api/stripe/webhook`, events:
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`.
3. **Render**: new Web Service from this repo, set env vars from `.env.example`.
4. **DNS (GoDaddy)**: point `charlestoncrm.com` at the Render service (custom domain + CNAME/A per Render).
5. Verify: signup → checkout (test card 4242 4242 4242 4242) → redirected into dashboard.

## KNOWN NEXT STEP — data isolation
The auth + billing SaaS shell is complete. Per-tenant **data isolation is not yet
wired**: CRM queries are not yet scoped by `owner_id`. Complete this before onboarding
a second customer (add `&owner_id=eq.<account>` to every read, set `owner_id` on every
write; the columns already exist via `subscription-schema.sql`).
