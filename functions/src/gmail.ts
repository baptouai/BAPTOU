import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { db, REGION } from "./shared.js";

// OAuth client from Google Cloud console (APIs & Services > Credentials). The ID is public and set in
// functions/.env; the secret and the token encryption key live in Secret Manager.
const clientId = defineString("GOOGLE_OAUTH_CLIENT_ID");
export const clientSecret = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
export const tokenKey = defineSecret("TOKEN_ENCRYPTION_KEY"); // 32 random bytes, base64
const appUrl = defineString("APP_URL", { default: "http://localhost:3000" });

// Read to find past conversations; send only for emails the user approved in the app.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
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
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const state = randomBytes(24).toString("hex");
  await db.doc(`private/${uid}`).set({ gmailOAuth: { state, createdAt: Date.now() } }, { merge: true });
  const params = new URLSearchParams({
    client_id: clientId.value(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // refresh token, so the daily jobs work without the user present
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: request.auth?.token.email ?? "",
    state: `${uid}.${state}`,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
});

/** Google redirects here after consent. Stores the encrypted refresh token, then returns to the app. */
export const gmailOAuthCallback = onRequest({ region: REGION, secrets: GMAIL_SECRETS }, async (req, res) => {
  const back = (status: string) => res.redirect(`${appUrl.value()}/profile?gmail=${status}`);
  try {
    const [uid, state] = String(req.query.state ?? "").split(".");
    const code = String(req.query.code ?? "");
    if (!uid || !state || !code) return back("cancelled");

    const priv = await db.doc(`private/${uid}`).get();
    const pending = priv.get("gmailOAuth") as { state: string; createdAt: number } | undefined;
    if (!pending || pending.state !== state || Date.now() - pending.createdAt > 10 * 60_000) return back("expired");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
    const tokens = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; scope?: string };
    if (!tokenRes.ok || !tokens.refresh_token || !tokens.access_token) {
      logger.error("Gmail token exchange failed", { status: tokenRes.status });
      return back("error");
    }
    const granted = tokens.scope?.split(" ") ?? [];
    const profile = (await gmailFetch(tokens.access_token, "profile")) as { emailAddress: string };

    await db.doc(`private/${uid}`).set(
      {
        gmail: { refreshToken: encrypt(tokens.refresh_token), email: profile.emailAddress, scopes: granted },
        gmailOAuth: FieldValue.delete(),
      },
      { merge: true },
    );
    await db.doc(`users/${uid}`).set(
      {
        gmail: {
          email: profile.emailAddress,
          canRead: granted.includes(SCOPES[0]),
          canSend: granted.includes(SCOPES[1]),
          needsReconnect: false,
          connectedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    );
    back("connected");
  } catch (e) {
    logger.error("Gmail OAuth callback failed", { error: String(e) });
    back("error");
  }
});

/** Revokes BAPTOU's Gmail access and deletes the stored token. */
export const gmailDisconnect = onCall({ region: REGION, secrets: GMAIL_SECRETS }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const priv = await db.doc(`private/${uid}`).get();
  const enc = priv.get("gmail.refreshToken") as string | undefined;
  if (enc) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(enc))}`, { method: "POST" }).catch(
      () => {},
    );
  }
  await db.doc(`private/${uid}`).update({ gmail: FieldValue.delete() });
  await db.doc(`users/${uid}`).update({ gmail: FieldValue.delete() });
  return { ok: true };
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

/** A Gmail client for this user, or an error asking them to connect Gmail. */
export async function gmailFor(uid: string): Promise<Gmail> {
  const priv = await db.doc(`private/${uid}`).get();
  const enc = priv.get("gmail.refreshToken") as string | undefined;
  if (!enc) throw new HttpsError("failed-precondition", "Connect your Gmail first (Profile page).");
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
  if (!token.access_token) {
    if (token.error === "invalid_grant") {
      // Revoked from the Google account, or expired (tokens of apps in testing mode expire after 7 days).
      await db.doc(`users/${uid}`).set({ gmail: { needsReconnect: true } }, { merge: true });
      throw new HttpsError("failed-precondition", "Your Gmail connection expired. Reconnect Gmail on the Profile page.");
    }
    throw new HttpsError("unavailable", "Couldn't reach Gmail. Try again.");
  }
  return { email: priv.get("gmail.email"), call: (path, init) => gmailFetch(token.access_token!, path, init) };
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
  mail: { to: string; subject: string; body: string; threadId?: string },
) {
  const reply = mail.threadId ? await threadReplyInfo(gmail, mail.threadId) : null;
  const headers = [
    `From: ${gmail.email}`,
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
