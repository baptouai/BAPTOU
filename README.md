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
8. Billing (Stripe), usage limits, privacy policy, account deletion
