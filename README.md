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
```

Secrets in Secret Manager: `ANTHROPIC_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`.

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

## Emails to users

Invitations, new-offer emails and cancellation confirmations are sent from the owner's Gmail
(`config/app.ownerUid`, which must have Gmail connected), with "BAPTOU" as the sender name
(`functions/src/notify.ts`). New offers: one summary per search run, or a dedicated email for each
offer scoring 90% or more. Users turn them off on their Profile page.

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
