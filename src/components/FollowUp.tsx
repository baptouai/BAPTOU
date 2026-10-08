"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where, type Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { RichText } from "@/components/RichText";
import { replyKind } from "@/components/Replies";
import type { Application } from "@/lib/types";

// Reply documents written by the daily reply check (functions/src/replies.ts).
type Reply = {
  kind: keyof typeof replyKind;
  summary: string;
  nextStep: string;
  dueDate: string;
  from: string;
  subject: string;
  threadId: string;
  receivedAt: Timestamp;
};

const DAY = 86_400_000;
const NUDGE_AFTER_DAYS = 14; // no news for this long: suggest a follow-up email

/** Where an application stands, from its status and latest reply. */
function standing(app: Application) {
  if (app.status === "rejected") return { label: "Rejected", className: replyKind.rejection.className };
  const k = app.lastReply?.kind;
  if (k === "offer") return { label: "Offer received", className: replyKind.offer.className };
  if (k === "interview") return { label: "Interview", className: replyKind.interview.className };
  if (k === "request") return { label: "Action needed", className: replyKind.request.className };
  if (k === "received") return { label: "Application received", className: replyKind.received.className };
  return { label: "Waiting for a reply", className: "border border-border text-muted" };
}

/**
 * On an application that was sent: where it stands, everything that happened since (replies spotted in the
 * mailbox, the email sent from BAPTOU), and a nudge to follow up when there's been no news for a while.
 */
export function FollowUp({
  applicationId,
  app,
  onDraftFollowUp,
  onSetStatus,
}: {
  applicationId: string;
  app: Application;
  onDraftFollowUp: (appliedOn: string) => Promise<void>;
  onSetStatus: (status: Application["status"]) => Promise<void>;
}) {
  const { user } = useAuth();
  const { t, date, day } = useI18n();
  const [replies, setReplies] = useState<(Reply & { id: string })[]>([]);
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "replies"), where("applicationId", "==", applicationId));
    return onSnapshot(q, (snap) =>
      setReplies(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Reply) }))
          .sort((a, b) => (b.receivedAt?.toMillis() ?? 0) - (a.receivedAt?.toMillis() ?? 0)),
      ),
    );
  }, [user, applicationId]);

  const appliedMs = (app.appliedAt ?? app.updatedAt)?.toMillis?.() ?? null;
  const days = appliedMs ? Math.floor((now - appliedMs) / DAY) : null;
  const s = standing(app);
  const quiet = app.status === "applied" && !replies.length && days != null && days >= NUDGE_AFTER_DAYS;

  type Event = { at: number; node: React.ReactNode };
  const events: Event[] = [
    ...replies.map((r) => ({
      at: r.receivedAt?.toMillis() ?? 0,
      node: (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${replyKind[r.kind]?.className ?? ""}`}>
              {t(replyKind[r.kind]?.label ?? "Other")}
            </span>
            <span className="text-muted [overflow-wrap:anywhere]">
              {r.from} · {r.subject || t("(no subject)")}
            </span>
          </div>
          <RichText text={r.summary} className="mt-1" />
          {r.nextStep && (
            <div className="mt-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                {t("Next step")}
                {r.dueDate && <span className="normal-case"> · {t("by {date}", { date: day(r.dueDate) })}</span>}
              </span>
              <RichText text={r.nextStep} />
            </div>
          )}
          <a
            href={`https://mail.google.com/mail/u/0/#all/${r.threadId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-accent hover:underline"
          >
            {t("Open in Gmail")} ↗
          </a>
        </div>
      ),
    })),
    ...(app.emailSentAt
      ? [{ at: app.emailSentAt.toMillis(), node: <p>{t("You emailed the recruiter from BAPTOU.")}</p> }]
      : []),
    ...(appliedMs ? [{ at: appliedMs, node: <p>{t("You applied.")}</p> }] : []),
  ].sort((a, b) => b.at - a.at);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-card-edge bg-card p-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">{t("Follow-up")}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.className}`}>{t(s.label)}</span>
      </div>
      {appliedMs && (
        <p className="mt-1 text-muted">
          {t(days === 0 ? "Applied on {date} (today)." : days === 1 ? "Applied on {date} (yesterday)." : "Applied on {date} ({n} days ago).", {
            date: date(appliedMs),
            n: days ?? 0,
          })}
        </p>
      )}

      {quiet && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
          <p>{t("No news for {n} days. A short, polite follow-up email often gets things moving.", { n: days ?? 0 })}</p>
          <button
            onClick={() => act(() => onDraftFollowUp(appliedMs ? date(appliedMs) : ""))}
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {t(busy ? "Writing…" : "Draft a follow-up email")}
          </button>
        </div>
      )}

      <ol className="mt-4 grid gap-3 border-l border-border pl-4">
        {events.map((e, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
            <p className="text-xs text-muted">{date(e.at, "short")}</p>
            {e.node}
          </li>
        ))}
      </ol>
      {!replies.length && (
        <p className="mt-3 text-xs text-muted">
          {t("BAPTOU checks your mailbox every morning and adds any reply about this application here (needs Gmail reading).")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        {app.status === "applied" ? (
          <button onClick={() => act(() => onSetStatus("rejected"))} disabled={busy} className="text-muted hover:text-foreground">
            {t("Mark as rejected")}
          </button>
        ) : (
          <button onClick={() => act(() => onSetStatus("applied"))} disabled={busy} className="text-muted hover:text-foreground">
            {t("Mark as still in progress")}
          </button>
        )}
      </div>
    </section>
  );
}
