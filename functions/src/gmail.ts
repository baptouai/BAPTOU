import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { defineSecret, defineString } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { claimGmailRead, gmailReadAvailable } from "./access.js";
import { db, REGION, requireAccess, requireUser } from "./shared.js";

// OAuth client from Google Cloud console (APIs & Services > Credentials). The ID is public and set in
// functions/.env; the secret and the token encryption key live in Secret Manager.
const clientId = defineString("GOOGLE_OAUTH_CLIENT_ID");
export const clientSecret = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
export const tokenKey = defineSecret("TOKEN_ENCRYPTION_KEY"); // 32 random bytes, base64
const appUrl = defineString("APP_URL", { default: "https://app.baptou.com" });
// Where Google may send the user back after consent: the app (its own domain, and the Firebase one it moved from)
// and local development.
const RETURN_ORIGINS = ["https://app.baptou.com", "https://baptou-app.web.app", "http://localhost:3000"];

// Read to find past conversations; send only for emails the user approved in the app.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
// The account's address, from the ID token: Gmail's profile endpoint needs read access, which not everyone has.
const IDENTITY = ["openid", "email"];
const redirectUri = () => `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/gmailOAuthCallback`;
export const GMAIL_SECRETS = [clientSecret, tokenKey];

// --- Token encryption (AES-256-GCM): refresh tokens are never stored in clear.

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(tokenKey.value(), "base64"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(blob: string) {
  const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(tokenKey.value(), "base64"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// --- OAuth

/** Returns the Google consent URL. `state` ties the callback to this user and expires after 10 minutes. */
export const gmailAuthUrl = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  await requireAccess(uid);
  const state = randomBytes(24).toString("hex");
  const origin = String(request.data?.returnTo ?? "");
  const returnTo = RETURN_ORIGINS.includes(origin) ? origin : appUrl.value();
  await db.doc(`private/${uid}`).set({ gmailOAuth: { state, returnTo, createdAt: Date.now() } }, { merge: true });
  const params = new URLSearchParams({
    client_id: clientId.value(),
    redirect_uri: redirectUri(),
    response_type: "code",
    // Reading is only requested while one of the 100 Gmail-reading places is available (see access.ts).
    scope: [...IDENTITY, ...((await gmailReadAvailable(uid)) ? SCOPES : SCOPES.slice(1))].join(" "),
    access_type: "offline", // refresh token, so the daily jobs work without the user present
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: request.auth?.token.email ?? "",
    state: `${uid}.${state}`,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
});

type Tokens = { refresh_token?: string; access_token?: string; scope?: string; id_token?: string };

/** Exchanges the consent code for tokens; null if Google refused. */
async function exchangeCode(code: string): Promise<Tokens | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId.value(),
      client_secret: clientSecret.value(),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await res.json()) as Tokens;
  if (!res.ok || !tokens.refresh_token || !tokens.access_token) {
    logger.error("Gmail token exchange failed", { status: res.status });
    return null;
  }
  return tokens;
}

/** The Google account's email address. The ID token comes straight from Google's token endpoint. */
async function accountEmail(tokens: Tokens) {
  const claims = tokens.id_token ? JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")) : {};
  if (claims.email) return String(claims.email);
  return ((await gmailFetch(tokens.access_token!, "profile")) as { emailAddress: string }).emailAddress;
}

/** Google redirects here after consent. Stores the encrypted refresh token, then returns to the app. */
export const gmailOAuthCallback = onRequest({ region: REGION, secrets: GMAIL_SECRETS }, async (req, res) => {
  let returnTo = appUrl.value();
  const back = (status: string) => res.redirect(`${returnTo}/profile?gmail=${status}`);
  try {
    const [uid, state] = String(req.query.state ?? "").split(".");
    const code = String(req.query.code ?? "");
    if (uid === "sender") {
      await connectSender(state, code, res);
      return;
    }
    if (!uid || !state || !code) return back("cancelled");

    const priv = await db.doc(`private/${uid}`).get();
    const pending = priv.get("gmailOAuth") as { state: string; returnTo?: string; createdAt: number } | undefined;
    if (pending?.returnTo && RETURN_ORIGINS.includes(pending.returnTo)) returnTo = pending.returnTo;
    if (!pending || pending.state !== state || Date.now() - pending.createdAt > 10 * 60_000) return back("expired");

    const tokens = await exchangeCode(code);
    if (!tokens) return back("error");
    const granted = tokens.scope?.split(" ") ?? [];
    if (granted.includes(SCOPES[0])) await claimGmailRead(uid);
    const email = await accountEmail(tokens);

    await db.doc(`private/${uid}`).set(
      {
        gmail: { refreshToken: encrypt(tokens.refresh_token!), email, scopes: granted },
        gmailOAuth: FieldValue.delete(),
      },
      { merge: true },
    );
    await db.doc(`users/${uid}`).set(
      {
        gmail: {
          email,
          canRead: granted.includes(SCOPES[0]),
          canSend: granted.includes(SCOPES[1]),
          needsReconnect: false,
          connectedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    );
    // Build the contact index (headers only, no AI). Queued by name to avoid importing mailIndex.ts here.
    await db.doc(`users/${uid}`).set({ mailIndex: { status: "queued" } }, { merge: true });
    await getFunctions()
      .taskQueue(`locations/${REGION}/functions/indexMailboxTask`)
      .enqueue({ uid })
      .catch((e) => logger.error("Couldn't queue mail index", { error: String(e) }));
    back("connected");
  } catch (e) {
    logger.error("Gmail OAuth callback failed", { error: String(e) });
    back("error");
  }
});

// --- BAPTOU's own mailbox (baptouai@gmail.com), which sends BAPTOU's emails to users (invitations, new
// offers, cancellations). Connected from BAPTOU Admin: it writes config/mailer.pending and opens Google's
// consent page with state "sender.<nonce>"; the callback lands here. Send permission only.

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>BAPTOU</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</body>`;

async function connectSender(state: string, code: string, res: { status(n: number): { send(b: string): unknown } }) {
  const done = (text: string) => res.status(200).send(page(text));
  const ref = db.doc("config/mailer");
  const pending = (await ref.get()).get("pending") as { state: string; email: string; createdAt: number } | undefined;
  if (!code) return done("Cancelled. Start again from BAPTOU Admin.");
  if (!pending || pending.state !== state || Date.now() - pending.createdAt > 10 * 60_000) {
    return done("This link has expired. Start again from BAPTOU Admin.");
  }
  const tokens = await exchangeCode(code);
  if (!tokens) return done("Google didn't give access. Try again from BAPTOU Admin.");
  if (!(tokens.scope?.split(" ") ?? []).includes(SCOPES[1])) {
    return done("Sending emails wasn't allowed. Try again from BAPTOU Admin and tick the Gmail box.");
  }
  const email = (await accountEmail(tokens)).toLowerCase();
  if (email !== pending.email) {
    return done(`You signed in as ${email}, not ${pending.email}. Try again from BAPTOU Admin and choose ${pending.email}.`);
  }
  await ref.set({
    refreshToken: encrypt(tokens.refresh_token!),
    email,
    connectedAt: FieldValue.serverTimestamp(),
  });
  logger.info("Sender mailbox connected", { email });
  return done(`Done: BAPTOU now sends its emails from ${email}. You can close this window.`);
}

/** BAPTOU's own mailbox, for the emails it sends to users. Throws if it isn't connected. */
export async function senderGmail(): Promise<Gmail> {
  const ref = db.doc("config/mailer");
  const config = await ref.get();
  const enc = config.get("refreshToken") as string | undefined;
  if (!enc) throw new Error("BAPTOU's sender email isn't connected (BAPTOU Admin > Sender email).");
  const access = await accessFrom(enc);
  if (!access) {
    await ref.set({ error: "Google access expired or was revoked." }, { merge: true });
    throw new Error("BAPTOU's sender email needs to be reconnected (BAPTOU Admin > Sender email).");
  }
  return { email: config.get("email") as string, call: (path, init) => gmailFetch(access, path, init) };
}

/** Revokes the user's Gmail grant at Google (best effort). */
export async function revokeGmail(uid: string) {
  const enc = (await db.doc(`private/${uid}`).get()).get("gmail.refreshToken") as string | undefined;
  if (!enc) return;
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(enc))}`, { method: "POST" }).catch(
    () => {},
  );
}

/**
 * Revokes BAPTOU's Gmail access and deletes the stored token. The contact index is kept (offers still
 * match against it) unless `clearIndex` is set.
 */
export const gmailDisconnect = onCall({ region: REGION, secrets: GMAIL_SECRETS }, async (request) => {
  const uid = requireUser(request);
  await revokeGmail(uid);
  const clearIndex = request.data?.clearIndex === true;
  await db.doc(`private/${uid}`).update({ gmail: FieldValue.delete() });
  await db.doc(`users/${uid}`).update({
    gmail: FieldValue.delete(),
    ...(clearIndex ? { mailIndex: FieldValue.delete() } : {}),
  });
  if (clearIndex) await db.recursiveDelete(db.collection(`users/${uid}/mailIndex`));
  return { ok: true, indexCleared: clearIndex };
});

// --- Gmail API (plain REST; googleapis is too heavy to load within the deploy timeout)

export type Gmail = { email: string; call: (path: string, init?: RequestInit) => Promise<unknown> };

async function gmailFetch(accessToken: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json();
}

/** Mailbox reading (contacts, index, replies) needs the read permission, which only the first 100 users have. */
export async function requireGmailRead(uid: string) {
  const priv = await db.doc(`private/${uid}`).get();
  const scopes = (priv.get("gmail.scopes") as string[] | undefined) ?? [];
  if (!scopes.includes(SCOPES[0])) {
    throw new HttpsError(
      "failed-precondition",
      "Reading your mailbox isn't available on your account yet. Sending emails you approve still works.",
    );
  }
}

/** A fresh access token from a stored refresh token; null when Google revoked or expired it. */
async function accessFrom(enc: string): Promise<string | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: decrypt(enc),
      client_id: clientId.value(),
      client_secret: clientSecret.value(),
      grant_type: "refresh_token",
    }),
  });
  const token = (await res.json()) as { access_token?: string; error?: string };
  if (token.access_token) return token.access_token;
  // Revoked from the Google account, or expired (tokens of apps in testing mode expire after 7 days).
  if (token.error === "invalid_grant") return null;
  throw new HttpsError("unavailable", "Couldn't reach Gmail. Try again.");
}

/** A Gmail client for this user, or an error asking them to connect Gmail. */
export async function gmailFor(uid: string): Promise<Gmail> {
  const priv = await db.doc(`private/${uid}`).get();
  const enc = priv.get("gmail.refreshToken") as string | undefined;
  if (!enc) throw new HttpsError("failed-precondition", "Connect your Gmail first (Profile page).");
  const access = await accessFrom(enc);
  if (!access) {
    await db.doc(`users/${uid}`).set({ gmail: { needsReconnect: true } }, { merge: true });
    throw new HttpsError("failed-precondition", "Your Gmail connection expired. Reconnect Gmail on the Profile page.");
  }
  return { email: priv.get("gmail.email"), call: (path, init) => gmailFetch(access, path, init) };
}

type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
type Message = { id: string; threadId: string; snippet?: string; internalDate?: string; payload?: Part };

const header = (m: Message, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function plainText(part: Part | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

/** Drops quoted replies ("> ...", "On ... wrote:") so each message is only what was newly written. */
function stripQuoted(text: string) {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^On .+wrote:$|^Le .+a écrit\s?:$|^-----Original Message-----|^De\s?: /.test(l.trim()));
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith(">")).join("\n").trim();
}

function htmlOf(part: Part | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/html" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return (part.parts ?? []).map(htmlOf).join("\n");
}

/** Emails received since `sinceMs` (newest first), with their text and the links they contain. */
export async function recentMessages(gmail: Gmail, sinceMs: number, max = 5) {
  const list = (await gmail.call(
    `messages?q=${encodeURIComponent(`in:anywhere after:${Math.floor(sinceMs / 1000) - 60}`)}&maxResults=${max}`,
  )) as { messages?: { id: string }[] };
  const messages = await Promise.all(
    (list.messages ?? []).map((m) => gmail.call(`messages/${m.id}?format=full`) as Promise<Message>),
  );
  return messages
    .filter((m) => Number(m.internalDate ?? 0) >= sinceMs - 60_000)
    .map((m) => {
      const text = plainText(m.payload).replace(/\s+\n/g, "\n").slice(0, 3000);
      const html = htmlOf(m.payload);
      const links = [...new Set([...`${html} ${text}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) => x[0].replace(/&amp;/g, "&")))];
      return { id: m.id, from: header(m, "From"), subject: header(m, "Subject"), receivedAt: Number(m.internalDate ?? 0), text, links };
    });
}

/** Searches the whole mailbox with Gmail's own query syntax; returns one line per message. */
export async function searchMail(gmail: Gmail, query: string, max = 15) {
  const list = (await gmail.call(`messages?q=${encodeURIComponent(query)}&maxResults=${max}`)) as {
    messages?: { id: string }[];
  };
  if (!list.messages?.length) return "No messages found.";
  const metas = await Promise.all(
    list.messages.map(
      (m) =>
        gmail.call(
          `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
        ) as Promise<Message>,
    ),
  );
  return metas
    .map(
      (m) =>
        `threadId=${m.threadId} | ${header(m, "Date")} | From: ${header(m, "From")} | To: ${header(m, "To")}${
          header(m, "Cc") ? ` | Cc: ${header(m, "Cc")}` : ""
        } | Subject: ${header(m, "Subject")} | ${m.snippet ?? ""}`,
    )
    .join("\n");
}

/** Reads a conversation: the last messages, quotes removed, each cut to a reasonable length. */
export async function readThread(gmail: Gmail, threadId: string) {
  const thread = (await gmail.call(`threads/${threadId}?format=full`)) as { messages?: Message[] };
  const messages = (thread.messages ?? []).slice(-6);
  return messages
    .map((m) => {
      const body = stripQuoted(plainText(m.payload)).slice(0, 2500);
      return `--- ${header(m, "Date")} | From: ${header(m, "From")} | To: ${header(m, "To")} | Subject: ${header(m, "Subject")}\n${body}`;
    })
    .join("\n\n");
}

/** Last message of a thread, for replying in it with proper threading headers. */
export async function threadReplyInfo(gmail: Gmail, threadId: string) {
  const thread = (await gmail.call(
    `threads/${threadId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`,
  )) as { messages?: Message[] };
  const last = thread.messages?.at(-1);
  if (!last) return null;
  return {
    messageId: header(last, "Message-ID"),
    references: header(last, "References"),
    subject: header(last, "Subject"),
  };
}

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

/** Sends one plain-text email from the user's Gmail, as a reply in `threadId` when given. */
export async function sendMail(
  gmail: Gmail,
  mail: { to: string; subject: string; body: string; threadId?: string; fromName?: string },
) {
  const reply = mail.threadId ? await threadReplyInfo(gmail, mail.threadId) : null;
  const headers = [
    `From: ${mail.fromName ? `${encodeHeader(mail.fromName)} <${gmail.email}>` : gmail.email}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    ...(reply?.messageId
      ? [`In-Reply-To: ${reply.messageId}`, `References: ${[reply.references, reply.messageId].filter(Boolean).join(" ")}`]
      : []),
  ];
  const raw = `${headers.join("\r\n")}\r\n\r\n${Buffer.from(mail.body, "utf8").toString("base64")}`;
  return (await gmail.call("messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url"), ...(reply ? { threadId: mail.threadId } : {}) }),
  })) as { id: string; threadId: string };
}
