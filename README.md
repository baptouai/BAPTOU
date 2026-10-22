# BAPTOU

An AI agent that helps students find internships and apply to master's programmes. It suggests and prepares everything; the user approves. No email is sent without an explicit click in the app.

## Stack

- Next.js (App Router) PWA, deployed on Firebase App Hosting (`europe-west1`)
- Firebase Auth (Google), Firestore (`eur3`), Cloud Storage
- Cloud Functions + Claude API for the agent (coming in the next steps)

## Data model

See [src/lib/types.ts](src/lib/types.ts). Everything a user owns lives under `users/{uid}`. `private/{uid}` holds server-only data (Gmail tokens, usage) and cannot be reached from the client. See [firestore.rules](firestore.rules).

## Local setup

1. `cp .env.local.example .env.local` and fill it in from Firebase console → Project settings → Your apps → Web app.
2. `npm install`
3. `npm run dev` and open http://localhost:3000

## Server configuration

`functions/.env` (not committed):

```
GOOGLE_OAUTH_CLIENT_ID=421746504296-s2gj4leri7bmngo3lp6j44mklpeofjbj.apps.googleusercontent.com
APP_URL=https://baptou-app.web.app
ANTHROPIC_FEDERATION_RULE_ID=fdrl_01EAQt2atGc6oWsX6iM6kpAS
ANTHROPIC_ORGANIZATION_ID=8dcbcd16-bd93-4af7-88f0-b9efc4828b62
ANTHROPIC_SERVICE_ACCOUNT_ID=svac_01WovSZskYYVwNfniyeUpUsr
ANTHROPIC_WORKSPACE_ID=wrkspc_01Gii9L2hccKRfym4sdYo39H
```

Secrets in Secret Manager: `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, and `ANTHROPIC_API_KEY` (only used if the federation IDs above are missing).

### Claude API authentication (workload identity federation)

No long-lived API key: the functions (running as the default compute service account) mint a Google ID
token for `baptou-claude@baptou-5041c.iam.gserviceaccount.com` (they hold
`roles/iam.serviceAccountOpenIdTokenCreator` on it), and the Anthropic SDK exchanges it for a short-lived
Claude access token. Anthropic side: Claude Console > Settings > Workload identity, issuer `google-cloud`
(accounts.google.com), rule `baptou-functions` (audience `https://api.anthropic.com`, sub
`100226828464799307803`, email as above) targeting service account `baptou-server` in the Default
workspace. `claudeAuthCheck` (Mondays, or run from Cloud Scheduler) logs which method is in use.

## Deployment

- App: https://baptou-app.web.app (static export in `out/`, Firebase Hosting target `app`)
- Home page and privacy policy: https://baptou-5041c.web.app (`site/`, target `site`)

```bash
npx firebase deploy --only hosting,functions,firestore:rules
```

## Invite-only access

AI features only work for invited users. To invite someone, create a document in Firestore
(database `baptou`) at `access/<their email in lowercase>`, optionally with a number field
`monthlyLimitUsd` (default 5).

## BAPTOU Admin (desktop app)

`admin/` is a small Electron app for the owner: subscribers, website visits, gifts, allowances, the sender
mailbox and suggestion feedback. It reads and writes Firestore with the Firebase CLI login
(`npx firebase login`). First time: `npm install` then `npm run shortcuts` in `admin/` (Desktop and Start
menu shortcuts). It refreshes itself every 30 seconds, and reloads by itself when its files change
(`index.html`, `commands.mjs`; a new `main.mjs` or `preload.cjs` relaunches it).

Website visits come from `siteHit` (`functions/src/siteStats.ts`), reached at `baptou.com/api/hit` through a
Hosting rewrite and called by `site/theme.js` on every page: no cookies, no IP addresses; daily totals in
`siteStats/{date}`, each page view in `siteVisits` (30-day TTL on `expireAt`). `baptou.com/?notrack` stops
counting the current browser.

## Emails to users

Invitations, new-offer emails and cancellation confirmations are sent from BAPTOU's own Gmail,
baptouai@gmail.com, with "BAPTOU" as the sender name (`functions/src/notify.ts`). Connect it once
from BAPTOU Admin (Sender email > Connect): it asks Google for send permission only and stores the
encrypted token in `config/mailer`. Until it's connected, these emails aren't sent. New offers: one summary per search run, or a dedicated email for each
offer scoring 90% or more. Users turn them off on their Profile page.

## Checking pages locally

`npm run emulators` starts local Auth and Firestore emulators; `npm run dev:emulators` runs the app on
port 3001 against them. Create an account in the Auth emulator, put test data under its uid, then in
the browser console run `testSignIn("<uid>")` (emulator mode only; never in production builds).

## Scheduled jobs

Europe/Paris time: 06:00 posting checks, 06:30 mailbox index, 07:00 searches (then new-offer emails),
07:30 reply checks, 09:00 yearly-commitment reminders (sent once, about 2 months before the end).

## Unlocking forms behind an email check

`unlockForm` (functions/src/unlock.ts): when a careers site shows its form only after the student
confirms their email, the student can click "Unlock the form". BAPTOU opens the site in a headless
Chrome on the server (`@sparticuz/chromium` + `puppeteer-core`, functions/src/browser.ts), the AI
types the student's Gmail address, reads the code or link from their Gmail (needs mailbox reading),
then the form page's text is read like a pasted form. Hard limits in code: no submit-like clicks, no
password fields, only codes/links that came by email, no internal addresses; stops at CAPTCHAs.
`browserCheck` (monthly, or run from Cloud Scheduler) checks that Chrome still starts.

## Languages

The app is in English and French: texts are written in English in the code and translated through
`src/lib/fr.ts` (`t("…")`, see `src/lib/i18n.tsx`). The language is saved on the account
(`users/{uid}.lang`) and also used for BAPTOU's emails and the AI's explanations.

## Legal pages

`site/terms.html` (CGV/CGU, French with English translation) and `site/legal.html` (mentions
légales) contain highlighted blanks (`<mark class="todo">`). They are excluded from hosting in
`firebase.json` until filled in; then remove them from `ignore` and deploy `hosting:site`.

## Deploy rules

```bash
npx firebase login
npx firebase use --add
npx firebase deploy --only firestore,storage
```

## Roadmap

1. ✅ Project skeleton: auth, document upload, application editor with autosave and versions
2. Profile extraction from uploaded documents (Claude)
3. Internship search (job APIs) and daily scan
4. Company/university research plus letter and email drafting
5. Gmail sending after approval (`gmail.send` scope)
6. Gmail contact search (`gmail.readonly`, test users only until CASA)
7. Master's programme discovery, deadlines and application packs
8. ✅ Billing (Stripe, test mode), usage limits, privacy policy, account export and deletion, in-app cancellation
9. Legal pages live, Stripe live mode, own domain and transactional email
