"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, doc, limit, onSnapshot, orderBy, query, updateDoc, type Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { RichText } from "@/components/RichText";
import { errorText, useI18n } from "@/lib/i18n";

// users/{uid}/replies/{messageId}, written by the daily reply check (functions/src/replies.ts).
type Reply = {
  applicationId: string;
  kind: "received" | "interview" | "rejection" | "offer" | "request" | "other";
  summary: string;
  nextStep: string;
  dueDate: string;
  from: string;
  subject: string;
  threadId: string;
  receivedAt: Timestamp;
  seen: boolean;
};

export const replyKind: Record<Reply["kind"], { label: string; className: string }> = {
  offer: { label: "Offer", className: "bg-green-500/15 text-green-700 dark:text-green-400" },
  interview: { label: "Interview", className: "bg-green-500/10 text-green-700 dark:text-green-400" },
  request: { label: "Action needed", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  received: { label: "Application received", className: "bg-accent/10 text-accent" },
  rejection: { label: "Rejected", className: "bg-red-500/10 text-red-700 dark:text-red-400" },
  other: { label: "Other", className: "border border-border text-muted" },
};

const scanRepliesNow = httpsCallable<void, { found: number }>(functions, "scanRepliesNow", { timeout: 300_000 });

/** Dashboard: replies to applications found in the mailbox, newest first; unread ones are highlighted. */
export function RepliesPanel() {
  const { user } = useAuth();
  const [replies, setReplies] = useState<(Reply & { id: string })[]>([]);
  const [canRead, setCanRead] = useState(false);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showRead, setShowRead] = useState(false);
  const { t, dateTime } = useI18n();

  useEffect(() => {
    if (!user) return;
    const unsubReplies = onSnapshot(
      query(collection(db, "users", user.uid, "replies"), orderBy("receivedAt", "desc"), limit(30)),
      (snap) => setReplies(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Reply) }))),
    );
    const unsubUser = onSnapshot(doc(db, "users", user.uid), (snap) => {
      setCanRead(snap.get("gmail.canRead") === true);
      setLastCheck((snap.get("replyScan.lastAt") as number | undefined) ?? null);
    });
    return () => {
      unsubReplies();
      unsubUser();
    };
  }, [user]);

  async function check() {
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await scanRepliesNow();
      setMessage(
        data.found ? t(data.found > 1 ? "{n} new replies." : "{n} new reply.", { n: data.found }) : t("No new replies."),
      );
    } catch (e) {
      setMessage(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (!canRead && !replies.length) return null; // needs Gmail reading (first 100 users)

  const unread = replies.filter((r) => !r.seen);
  const shown = showRead ? replies : unread;

  return (
    <section className="mt-6 rounded-xl border border-card-edge bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">
            {t("Replies to your applications")}
            {unread.length > 0 && (
              <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs text-white">{t("{n} new", { n: unread.length })}</span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {lastCheck
              ? t("BAPTOU checks your mailbox every morning (last check {date}).", { date: dateTime(lastCheck * 1000) })
              : t("BAPTOU checks your mailbox every morning.")}
          </p>
        </div>
        {canRead && (
          <button onClick={check} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">
            {t(busy ? "Checking…" : "Check now")}
          </button>
        )}
      </div>
      {message && <p className="mt-2 text-sm text-muted">{message}</p>}

      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t(replies.length ? "No new replies." : "No replies yet.")}</p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-3">
          {shown.map((r) => (
            <ReplyCard key={r.id} reply={r} />
          ))}
        </ul>
      )}
      {replies.length > unread.length && (
        <button onClick={() => setShowRead((v) => !v)} className="mt-3 text-sm text-muted">
          {showRead ? t("Hide read replies") : t("Show read replies ({n})", { n: replies.length - unread.length })}
        </button>
      )}
    </section>
  );
}

function ReplyCard({ reply: r }: { reply: Reply & { id: string } }) {
  const { user } = useAuth();
  const { t, date, day } = useI18n();
  const k = replyKind[r.kind];
  const markSeen = () => user && updateDoc(doc(db, "users", user.uid, "replies", r.id), { seen: true });

  return (
    <li className={`min-w-0 rounded-lg border p-4 text-sm ${r.seen ? "border-card-edge-soft opacity-70" : "border-card-edge-soft"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium [overflow-wrap:anywhere]">{r.subject || t("(no subject)")}</p>
          <p className="text-muted [overflow-wrap:anywhere]">
            {r.from} · {r.receivedAt ? date(r.receivedAt.toDate(), "short") : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${k.className}`}>{t(k.label)}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("What it says")}</p>
          <RichText text={r.summary} className="mt-1" />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("Next step")}
            {r.dueDate && <span className="normal-case"> · {t("by {date}", { date: day(r.dueDate) })}</span>}
          </p>
          <RichText text={r.nextStep} className="mt-1" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {r.applicationId && (
          <Link href={`/applications/view?id=${r.applicationId}`} className="text-accent hover:underline" onClick={markSeen}>
            {t("Open the application")}
          </Link>
        )}
        <a
          href={`https://mail.google.com/mail/u/0/#all/${r.threadId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
          onClick={markSeen}
        >
          {t("Open in Gmail")} ↗
        </a>
        {!r.seen && (
          <button onClick={markSeen} className="text-muted hover:text-foreground">
            {t("Mark as read")}
          </button>
        )}
      </div>
    </li>
  );
}
