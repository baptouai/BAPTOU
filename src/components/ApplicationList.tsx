"use client";

import Link from "next/link";
import { useState } from "react";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { DismissForm } from "@/components/DismissForm";
import { verdictLabel } from "@/components/FitCheck";
import { RichText } from "@/components/RichText";
import { looksGeneric } from "@/lib/postingLink";
import { replyKind } from "@/components/Replies";
import type { Timestamp } from "firebase/firestore";
import type { Application } from "@/lib/types";
import { errorText, useI18n } from "@/lib/i18n";

export const statusLabel: Record<Application["status"], string> = {
  suggested: "To review",
  interested: "Interested",
  editing: "In progress",
  approved: "Approved",
  applied: "Applied",
  rejected: "Rejected",
  dismissed: "Dismissed",
};

/** "Not for me": the server deletes the offer and remembers it so no search suggests it again. */
export const dismissOffer = httpsCallable<{ applicationId: string; reason: string }, { ok: boolean }>(
  functions,
  "dismissOffer",
);

const INTERESTED: Application["status"][] = ["interested", "editing", "approved", "applied", "rejected"];

type Tab = "latest" | "review" | "interested";
type Item = Application & { id: string };

const batchTime = (a: Item) => (a.batchAt ?? a.createdAt)?.toMillis?.() ?? 0;
const dayOf = (ms: number) => new Date(ms).toDateString();
const dayStart = (ms: number) => new Date(new Date(ms).toDateString()).getTime();

export type ApplicationItem = Item;

/** One search's offers, split into Latest batch / To review / Interested. */
/** The search's most recent run, so "Latest batch" shows that run, even when it found nothing. */
export type LastRun = { at?: Timestamp; batchAt?: Timestamp; summary?: string };

export function ApplicationList({ apps, empty, lastRun }: { apps: Item[]; empty: string; lastRun?: LastRun }) {
  const [tab, setTab] = useState<Tab>("latest");
  const { t, date, dateTime } = useI18n();

  // Latest batch = the offers of the search's last run. Runs from before runs were recorded fall back
  // to the most recent day that produced offers.
  const runBatch = lastRun?.batchAt?.toMillis();
  const latestMs = apps.length ? Math.max(...apps.map(batchTime)) : null;
  const latestDay = latestMs != null ? dayOf(latestMs) : null;
  const lists: Record<Tab, Item[]> = {
    latest: runBatch
      ? apps.filter((a) => a.batchAt?.toMillis() === runBatch)
      : apps.filter((a) => dayOf(batchTime(a)) === latestDay),
    review: apps.filter((a) => a.status === "suggested"),
    interested: apps.filter((a) => INTERESTED.includes(a.status)),
  };
  const sorted = [...lists[tab]].sort((a, b) =>
    tab === "interested"
      ? (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0)
      : (b.matchScore ?? 0) - (a.matchScore ?? 0) || batchTime(b) - batchTime(a),
  );

  const tabs: { id: Tab; label: string; hint: string }[] = [
    {
      id: "latest",
      label: t("Latest batch"),
      hint: runBatch
        ? t("Found by this search's last run, {date}.", { date: dateTime(runBatch) })
        : latestMs != null
          ? t("Found by this search's last run, on {date}.", { date: date(dayStart(latestMs)) })
          : "",
    },
    { id: "review", label: t("To review"), hint: t("Everything from this search you haven't decided on yet.") },
    { id: "interested", label: t("Interested"), hint: t("The ones you're interested in or working on.") },
  ];

  return (
    <div className="mt-6">
      <div role="tablist" className="flex gap-1 scroll-row border-b border-border">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={tab === tb.id}
            onClick={() => setTab(tb.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
              tab === tb.id ? "border-accent font-medium text-accent" : "border-transparent text-muted"
            }`}
          >
            {tb.label} <span className="text-xs">({lists[tb.id].length})</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted">{tabs.find((tb) => tb.id === tab)?.hint}</p>

      {sorted.length === 0 ? (
        <p className="mt-4 rounded-xl border border-card-edge bg-card p-5 text-muted">
          {apps.length === 0 && tab !== "latest"
            ? empty
            : tab === "latest"
              ? runBatch
                ? t("The last run ({date}) found nothing new. Earlier suggestions are under “To review”.", { date: dateTime(runBatch) })
                : empty
              : tab === "interested"
                ? t("Mark offers as interesting to keep them here.")
                : t("Nothing here.")}
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {sorted.map((a) => (
            <li key={a.id}>
              <OfferCard app={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OfferCard({ app: a }: { app: Item }) {
  const { user } = useAuth();
  const { t, date } = useI18n();
  const [error, setError] = useState<string | null>(null);

  async function interested() {
    if (!user) return;
    await updateDoc(doc(db, "users", user.uid, "applications", a.id), { status: "interested", updatedAt: serverTimestamp() });
  }

  return (
    <div className="rounded-xl border border-card-edge-soft bg-card p-5">
      <Link href={`/applications/view?id=${a.id}`} className="block hover:text-accent">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-medium">{a.title}</p>
            <p className="text-sm text-muted">
              {a.organization}
              {a.country ? ` · ${a.country}` : ""}
              {a.deadline ? ` · ${t("deadline {date}", { date: date(a.deadline.toDate(), "short") })}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {a.lastReply && a.lastReply.kind !== "other" && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${replyKind[a.lastReply.kind].className}`}>
                {t(replyKind[a.lastReply.kind].label)}
              </span>
            )}
            {a.postingClosedAt && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
                {t("Posting closed")}
              </span>
            )}
            {!a.postingClosedAt && looksGeneric(a.applyUrl) && (
              <span
                className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                title={t("This link goes to a careers page, not to the posting itself")}
              >
                {t("General careers page")}
              </span>
            )}
            {a.source === "manual" && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{t("Added by you")}</span>
            )}
            {a.fromJobBoard && (
              <span
                className="rounded-full border border-border px-2 py-0.5 text-xs text-muted"
                title={t("BAPTOU couldn't find this offer on the organization's own website")}
              >
                {t("Via a job board")}
              </span>
            )}
            {a.fitVerdict && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${verdictLabel[a.fitVerdict].className}`}>
                {t(verdictLabel[a.fitVerdict].text)}
              </span>
            )}
            {a.matchScore != null && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t("{n}% match", { n: a.matchScore })}</span>
            )}
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground">{t(statusLabel[a.status])}</span>
          </div>
        </div>
        {a.matchReason && <RichText text={a.matchReason} limit={2} className="mt-2 text-sm text-muted" />}
      </Link>

      {a.status === "suggested" && (
        <div className="mt-3 flex flex-wrap items-start gap-2 text-sm">
          <button onClick={interested} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white">
            {t("I'm interested")}
          </button>
          <DismissForm
            onDismiss={async (reason) => {
              try {
                await dismissOffer({ applicationId: a.id, reason });
              } catch (e) {
                setError(errorText(e, t));
              }
            }}
          />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
