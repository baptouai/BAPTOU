// BAPTOU Admin: a small local tool to manage testers and limits.
// Runs on 127.0.0.1 only, uses the Firebase CLI login (`npx firebase login`) to call Firestore,
// and stops by itself when its window is closed.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const auth = require(join(here, "..", "node_modules", "firebase-tools", "lib", "auth.js"));

const PROJECT = "baptou-5041c";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/baptou/documents`;
const DEFAULT_LIMIT = 6.6; // €6 allowance; keep in sync with PLAN_BUDGET_USD in functions/src/shared.ts
const GMAIL_READ_CAP = 100; // keep in sync with functions/src/access.ts
const PORT = 4545;
const TOKEN = randomBytes(16).toString("hex"); // the page gets it; other websites can't
const month = () => new Date().toISOString().slice(0, 7);

// --- Firestore REST with the Firebase CLI's credentials

let cached = { token: "", until: 0 };
async function accessToken() {
  if (Date.now() < cached.until) return cached.token;
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Not logged in to Firebase. Run: npx firebase login");
  const { access_token } = await auth.getAccessToken(account.tokens.refresh_token, []);
  cached = { token: access_token, until: Date.now() + 30 * 60_000 };
  return access_token;
}

async function fs(path, init = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json();
}

async function list(collection) {
  const docs = [];
  let pageToken = "";
  do {
    const page = await fs(`${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`);
    docs.push(...(page?.documents ?? []));
    pageToken = page?.nextPageToken ?? "";
  } while (pageToken);
  return docs;
}

const id = (doc) => doc.name.split("/").pop();
const num = (v) => (v ? Number(v.doubleValue ?? v.integerValue ?? 0) : undefined);
const str = (v) => v?.stringValue;

// --- Commands

async function overview() {
  const [users, priv, access, slots] = await Promise.all([list("users"), list("private"), list("access"), fs("config/gmailRead")]);
  const privById = Object.fromEntries(priv.map((d) => [id(d), d.fields ?? {}]));
  const gifts = Object.fromEntries(access.map((d) => [decodeURIComponent(id(d)), d.fields ?? {}]));
  const m = month();
  const now = Date.now();
  const live = (ts) => !ts || Date.parse(ts) > now;

  const rows = users.map((u) => {
    const f = u.fields ?? {};
    const p = privById[id(u)] ?? {};
    const email = (str(f.email) ?? "").toLowerCase();
    const personal = num(p.monthlyLimitUsd);
    const plan = p.plan?.mapValue?.fields;
    const planEnd = plan?.currentPeriodEnd?.timestampValue;
    const planActive = plan && ["active", "past_due"].includes(str(plan.status)) && live(planEnd);
    const gift = gifts[email];
    const giftEnd = gift?.expiresAt?.timestampValue ?? null;
    // Same order as the server (functions/src/shared.ts entitlementFor): owner, paid plan, gift.
    const access =
      personal != null
        ? { kind: "owner", until: null }
        : planActive
          ? { kind: str(plan.type), until: planEnd ?? null }
          : gift && live(giftEnd)
            ? { kind: "gift", until: giftEnd }
            : gift
              ? { kind: "gift expired", until: giftEnd }
              : { kind: "none", until: null };
    const limitUsd = personal ?? (access.kind === "none" || access.kind === "gift expired" ? null : (num(gift?.monthlyLimitUsd) ?? DEFAULT_LIMIT));
    return {
      uid: id(u),
      email,
      name: str(f.displayName) ?? "",
      access,
      hasGift: !!gift,
      isOwner: personal != null,
      limitUsd,
      spentUsd: num(p.spendUsd?.mapValue?.fields?.[m]) ?? 0,
      gmail: !!str(f.gmail?.mapValue?.fields?.email),
      gmailRead: p.gmailRead?.booleanValue === true,
    };
  });
  const known = new Set(rows.map((r) => r.email));
  const pending = Object.entries(gifts)
    .filter(([email]) => !known.has(email))
    .map(([email, f]) => ({ email, until: f.expiresAt?.timestampValue ?? null }));
  return {
    month: m,
    defaultLimit: DEFAULT_LIMIT,
    gmailRead: { granted: num(slots?.fields?.granted) ?? 0, cap: GMAIL_READ_CAP },
    users: rows,
    pending,
  };
}

const cleanEmail = (e) => {
  const email = String(e ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email address.");
  return email;
};
const cleanLimit = (v) => {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("The limit must be between 0 and 1000 dollars.");
  return Math.round(n * 100) / 100;
};

/** Gifts a subscription to an email address for `months` months (0 = no end date). */
async function gift({ email, months }) {
  email = cleanEmail(email);
  const n = Number(months);
  if (![0, 1, 3, 6, 12].includes(n)) throw new Error("Choose a duration.");
  const fields = { gift: { booleanValue: true }, invitedAt: { timestampValue: new Date().toISOString() } };
  if (n > 0) {
    const end = new Date();
    end.setMonth(end.getMonth() + n);
    fields.expiresAt = { timestampValue: end.toISOString() };
  }
  // Replace the whole gift (a new duration replaces the old one, an end date can be removed).
  await fs(`access/${encodeURIComponent(email)}`, { method: "PATCH", body: JSON.stringify({ fields }) });
}

async function removeInvite({ email }) {
  await fs(`access/${encodeURIComponent(cleanEmail(email))}`, { method: "DELETE" });
}

/** Sets a monthly limit where it applies: the personal limit if the user has one, otherwise their invite. */
async function setLimit({ email, uid, limitUsd }) {
  email = cleanEmail(email);
  const limit = cleanLimit(limitUsd);
  if (limit == null) throw new Error("Enter a limit.");
  const priv = uid ? await fs(`private/${uid}`) : null;
  if (priv?.fields?.monthlyLimitUsd != null) {
    await fs(`private/${uid}?updateMask.fieldPaths=monthlyLimitUsd`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { monthlyLimitUsd: { doubleValue: limit } } }),
    });
  } else {
    await fs(`access/${encodeURIComponent(email)}?updateMask.fieldPaths=monthlyLimitUsd&updateMask.fieldPaths=invitedAt`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: { monthlyLimitUsd: { doubleValue: limit }, invitedAt: { timestampValue: new Date().toISOString() } },
      }),
    });
  }
  // Update the usage meter in the app right away (it is otherwise refreshed on the next AI call).
  if (uid) {
    await fs(`users/${uid}?updateMask.fieldPaths=usageSummary.limitUsd`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { usageSummary: { mapValue: { fields: { limitUsd: { doubleValue: limit } } } } } }),
    }).catch(() => {});
  }
}

const commands = { overview, gift, removeInvite, setLimit };

// --- Server

let lastPing = Date.now();
const page = () => readFileSync(join(here, "index.html"), "utf8").replace("__TOKEN__", TOKEN);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(page());
  }
  if (req.method === "GET" && url.pathname === "/logo.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    return res.end(readFileSync(join(here, "..", "public", "logo.svg")));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (req.headers["x-admin-token"] !== TOKEN) {
      res.writeHead(403);
      return res.end();
    }
    lastPing = Date.now();
    const name = url.pathname.slice(5);
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      if (name === "ping") return res.end("{}");
      if (!commands[name]) throw new Error("Unknown command.");
      const result = await commands[name](body ? JSON.parse(body) : {});
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result ?? { ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  res.writeHead(404);
  res.end();
});

server.on("error", (e) => {
  // Already running: just open another window on it.
  if (e.code === "EADDRINUSE") openWindow().then(() => process.exit(0));
  else throw e;
});

function openWindow() {
  const url = `http://127.0.0.1:${PORT}/`;
  // Edge app mode gives a standalone window without tabs or address bar.
  spawn("cmd", ["/c", "start", "", "msedge", `--app=${url}`, "--window-size=980,720"], { detached: true, stdio: "ignore" }).unref();
  return Promise.resolve();
}

server.listen(PORT, "127.0.0.1", () => {
  if (!process.env.BAPTOU_ADMIN_NO_WINDOW) openWindow();
  // The window pings every 5 seconds; stop when it has been closed for a while.
  setInterval(() => {
    if (Date.now() - lastPing > 30_000) process.exit(0);
  }, 5_000);
});
