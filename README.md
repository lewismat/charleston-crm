# Tampa Bay Mahj — Event Inquiry Form + Dashboard

A classy, mahjong-themed inquiry form for Holly's clients, with a private
dashboard showing every lead and every visit. Zero dependencies — just Node.js.

## Run on your computer (localhost)

1. Install Node.js if you don't have it: https://nodejs.org (LTS version)
2. Double-click **start.bat** (or run `node server.js` in this folder)
3. Open:
   - **Form (share this):** http://localhost:3000
   - **Holly's dashboard:** http://localhost:3000/dashboard

Submissions and visits are saved to `data/db.json` — back this file up to keep leads.

## What's inside

- `server.js` — web server + API + JSON database (no npm install needed)
- `public/index.html` — the inquiry form: a tile rack fills as fields are completed, tiles fly to the rack, confetti bursts on submit
- `public/dashboard.html` — leads with expandable details + status tracking (new / contacted / booked / archived), visit log with referrer + device, conversion stats. Auto-refreshes every 30s.

## Push to free hosting later

The app needs a Node host (not static hosting like Netlify or GitHub Pages):

- **Render.com (free tier):** create a Web Service from this folder. Build command: none. Start command: `node server.js`. Note: free-tier disks are wiped on redeploy/sleep — before going live, ask Claude to switch storage to a free cloud database so leads are permanent.
- **Railway** and **Fly.io** work the same way.

The dashboard has **no password** (per your choice) — once hosted, anyone with the /dashboard link can view leads. Easy to add later.

## Swapping in the real logo / adding Holly's photo

The logo is recreated as an SVG inside both HTML files (search for aria-label="Tampa Bay Mahj logo").
To use the real file instead, drop logo.png into public/ and replace the <svg>...</svg> block with:

    <img src="/logo.png" class="logo" alt="Tampa Bay Mahj">

To add Holly's photo later, drop holly.jpg into public/ and ask Claude to place it — the header is ready for it.
