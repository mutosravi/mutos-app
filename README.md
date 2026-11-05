# Muto's app

The studio's all-in-one app (shoot board, crew, gear desk, clients, attendance & salary). Built from the season team app; see CLAUDE.md for how it fits together and `supabase/004_studio.sql` for the new database rules.

# Muto's Studio · Team app (beta)

The shoot-assignment board as a website with Google sign-in:

| Who signs in | What they get |
|---|---|
| **Owner** (Ravi) | The full board, plus **Team logins** to add or remove managers |
| **Manager** | The full board (cannot change logins or seasons) |
| **Crew** (shooters, assistants) | **My shoots**: only their own upcoming shoots, with venue and map, report time, their job and gear, teammates, the client's name and number, and studio notes |
| Anyone else | A page asking them to send their Gmail to Ravi |

The Claude-hosted board keeps working as before. This app is a separate copy with its own database, so run both until you trust the app.

## How it fits together

- `src/shoot-board.html`: the same board file used inside Claude (copy the latest one in when the board changes).
- `tools/build-board.py`: turns it into `public/board.html` for the app. Run `python3 tools/build-board.py` after every board update.
- `public/`: the website. `index.html` (sign-in and routing), `board.html` (built), `crew.html` (My shoots), `shim.js` (gives the board its database), `crew-sync.js` (keeps every crew member's page up to date and handles Team logins), `config.js` (your Supabase address and key).
- `supabase/schema.sql`: the database tables and privacy rules. Crew can read only their own page; nobody outside the team list can read anything.
- `worker/`: the small server Cloudflare runs: serves `public/` and sends the evening reminders (`wrangler.jsonc` holds the schedule).
- `tests/`: end-to-end tests with a fake database, the reminder job test, and SQL access-rule tests.

## One-time setup (about 45 minutes)

### 1. Supabase (database and logins)
1. Sign up at supabase.com → **New project**. Name `mutos-team`, region **South Asia (Mumbai)**, save the database password somewhere safe.
2. Open **SQL Editor** → **New query**, paste all of `supabase/schema.sql`.
3. In the last statement, replace `your.gmail@gmail.com` with the Gmail you will sign in with (exactly as it appears in Gmail). Click **Run**. It should say "Success".
4. **Project Settings → API Keys**: copy the **Project URL** and the **Publishable key** (`sb_publishable_…`). Never use the secret key here.

### 2. Google sign-in
1. Go to console.cloud.google.com → create a project `Mutos Team`.
2. **APIs & Services → OAuth consent screen**: External; app name `Muto's Studio Team`; your email as support and developer contact. Add only the default scopes (email, profile). Then **Publish app** so any Gmail can sign in (with only these basic scopes Google does not need a review).
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized redirect URIs** add `https://YOUR-PROJECT.supabase.co/auth/v1/callback` (your Project URL + `/auth/v1/callback`). Create, then copy the **Client ID** and **Client secret**.
4. Back in Supabase: **Authentication → Sign In / Providers → Google** → enable, paste the Client ID and secret, save.

### 3. Put the website online (Cloudflare Pages, free)
1. Edit `public/config.js` in GitHub (pencil icon) and paste the Project URL and Publishable key. Commit.
2. dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** → choose `mutos-team-app`.
   Build command: *(leave empty)* · Build output directory: `public` → **Save and Deploy**.
3. Note the address it gives you, e.g. `https://mutos-team-app.pages.dev`.
4. In Supabase: **Authentication → URL Configuration** → Site URL = that address; under Redirect URLs add `https://mutos-team-app.pages.dev/**`. Save.

### 4. Move your data in
1. In the Claude board: **Save backup** (downloads a `.json` file).
2. Open the app address, sign in with your Gmail → you land on the board (empty) → **Load backup** → pick that file.
3. Check the shoot count matches the Claude board.

### 5. Give the crew access
1. In the app board: **Manage shooters → edit** on a person → fill **Login Gmail** → Save. Do the same for assistants.
2. Within a few seconds their login and their "My shoots" page are created. **Team logins** (top strip) shows who has access and who still has no Login Gmail.
3. Send them the app address. On iPhone: open in Safari → Share → **Add to Home Screen**. On Android: Chrome menu → **Add to Home screen**.
4. Use **Crew view** in the top strip to see exactly what any crew member sees.

## Crew actions and reminders (step 2)
Crew can, from their own page: confirm or say they can't make a shoot, add shoots to Google or phone calendar, mark gear picked up / returned, mark data handed over (last 30 days), and mark dates they are not available. A date more than 7 days away with no shoot is blocked straight away; a date they are booked on, or within 7 days, waits for your approval in **Team updates** on the board. Accepted dates appear in the board's away list automatically.

Setup, once:
1. Supabase → SQL Editor → New query → paste `supabase/002_crew_actions.sql` → Run.
2. Phone reminders (7 pm the evening before each shoot): in Cloudflare → Workers & Pages → `mutos-team-app` → Settings → Variables and Secrets, add two **Secrets**:
   - `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys → Secret key (`sb_secret_…`). Never paste it anywhere else.
   - `VAPID_PRIVATE_KEY`: the private notification key Claude gave you (the public half is already in `config.js` and `wrangler.jsonc`).
3. Crew turn reminders on with the 🔔 button on their page (iPhone: only after Add to Home Screen) and can send themselves a test.

## Gear desk (step 3)
A separate page for a gear manager: who took which item, who returned it, when, and in what condition. The gear manager signs in with Google and sees only the Gear desk (no board, no client details).
- **Day:** for any date, each shoot's gear per person from the board: tick and hand out, see what is already with them, pass an item straight from one person to another; plus what to collect back.
- **Out now:** everything out, by person, with overdue flags; Receive with condition (Good / Minor issue / Damaged / Missing parts) and a note, or pass it straight on.
- **Items:** every item with how many are in the studio, who has the rest, and damage notes. **Log:** every entry, searchable, signed by who made it.
Setup: run `supabase/003_gear_desk.sql` in Supabase, then **Team logins → Add gear manager**. Owners and managers open it from **Gear desk** in the board's top strip.

## Team Alignment sync (step 4)
The board reads the Team Alignment sheet through a read-only Google service account, as it did in Claude.
1. Google Cloud (same project as sign-in) → APIs & Services → Library → **Google Drive API** → Enable.
2. IAM & Admin → Service Accounts → Create `team-sheet-reader` (no roles) → Keys → Add key → JSON.
3. Cloudflare → Variables and Secrets → Secret `GOOGLE_SERVICE_ACCOUNT` = the whole JSON file.
4. Share the Team Alignment sheet with the service account's email as **Viewer**.
The owner's board syncs on opening (at most every 10 minutes) and with **Sync now**.

## Things to know in the beta
- The two boards do not sync with each other. Pick one day to switch: Save backup from Claude, Load backup in the app, and from then on edit only in the app.
- The Drive crew sheet and reminders file are not used in the app: crew pages and phone reminders replace them. WhatsApp send buttons work as before.
- Crew pages update whenever someone with the board open saves a change, and every 10 minutes while the board is open.
- Managers cannot edit seasons; if a manager's change fails with "You can view this board but not change it", that is why.
- Gmail addresses are matched exactly (lowercase). If someone signs in and sees "not on the team list", compare the address on that page with their Login Gmail.

## Making changes later
Attach this repository to a Claude chat and describe the change. Board features are made in `src/shoot-board.html`, then `python3 tools/build-board.py` rebuilds the app copy. Cloudflare redeploys automatically on every push.
