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

export type ApplicationItem = Item;

/** One search's offers, split into Latest batch / To review / Interested. */
/** The search's most recent run, so "Latest batch" shows that run, even when it found nothing. */
export type LastRun = { at?: Timestamp; batchAt?: Timestamp; summary?: string };

export function ApplicationList({ apps, empty, lastRun }: { apps: Item[]; empty: string; lastRun?: LastRun }) {
  const [tab, setTab] = useState<Tab>("latest");

  // Latest batch = the offers of the search's last run. Runs from before runs were recorded fall back
  // to the most recent day that produced offers.
  const runBatch = lastRun?.batchAt?.toMillis();
  const latestDay = apps.length ? dayOf(Math.max(...apps.map(batchTime))) : null;
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
      label: "Latest batch",
      hint: runBatch
        ? `Found by this search's last run, ${new Date(runBatch).toLocaleString()}.`
        : latestDay
          ? `Found by this search's last run, on ${new Date(latestDay).toLocaleDateString()}.`
          : "",
    },
    { id: "review", label: "To review", hint: "Everything from this search you haven't decided on yet." },
    { id: "interested", label: "Interested", hint: "The ones you're interested in or working on." },
  ];

  return (
    <div className="mt-6">
      <div role="tablist" className="flex gap-1 scroll-row border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
              tab === t.id ? "border-accent font-medium text-accent" : "border-transparent text-muted"
            }`}
          >
            {t.label} <span className="text-xs">({lists[t.id].length})</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted">{tabs.find((t) => t.id === tab)?.hint}</p>

      {sorted.length === 0 ? (
        <p className="mt-4 rounded-xl border border-card-edge bg-card p-5 text-muted">
          {apps.length === 0 && tab !== "latest"
            ? empty
            : tab === "latest"
              ? runBatch
                ? `The last run (${new Date(runBatch).toLocaleString()}) found nothing new. Earlier suggestions are under “To review”.`
                : empty
              : tab === "interested"
                ? "Mark offers as interesting to keep them here."
                : "Nothing here."}
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
              {a.deadline ? ` · deadline ${a.deadline.toDate().toLocaleDateString()}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {a.lastReply && a.lastReply.kind !== "other" && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${replyKind[a.lastReply.kind].className}`}>
                {replyKind[a.lastReply.kind].label}
              </span>
            )}
            {a.postingClosedAt && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
                Posting closed
              </span>
            )}
            {!a.postingClosedAt && looksGeneric(a.applyUrl) && (
              <span
                className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                title="This link goes to a careers page, not to the posting itself"
              >
                General careers page
              </span>
            )}
            {a.source === "manual" && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">Added by you</span>
            )}
            {a.fitVerdict && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${verdictLabel[a.fitVerdict].className}`}>
                {verdictLabel[a.fitVerdict].text}
              </span>
            )}
            {a.matchScore != null && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{a.matchScore}% match</span>
            )}
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground">{statusLabel[a.status]}</span>
          </div>
        </div>
        {a.matchReason && <RichText text={a.matchReason} limit={2} className="mt-2 text-sm text-muted" />}
      </Link>

      {a.status === "suggested" && (
        <div className="mt-3 flex flex-wrap items-start gap-2 text-sm">
          <button onClick={interested} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white">
            I&apos;m interested
          </button>
          <DismissForm
            onDismiss={async (reason) => {
              try {
                await dismissOffer({ applicationId: a.id, reason });
              } catch (e) {
                setError(e instanceof Error ? e.message : "Something went wrong");
              }
            }}
          />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
