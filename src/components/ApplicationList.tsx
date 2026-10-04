"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { DismissForm } from "@/components/DismissForm";
import { verdictLabel } from "@/components/FitCheck";
import type { Application, ApplicationType } from "@/lib/types";

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

export function ApplicationList({ type, empty }: { type: ApplicationType; empty: string }) {
  const { user } = useAuth();
  const [apps, setApps] = useState<Item[] | null>(null);
  const [tab, setTab] = useState<Tab>("latest");

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "applications"), where("type", "==", type));
    return onSnapshot(q, (snap) => setApps(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Application) }))));
  }, [user, type]);

  if (!apps) return <p className="mt-6 text-muted">Loading…</p>;

  // The latest batch is everything from the most recent day the searches ran (several searches can run that morning).
  const latestDay = apps.length ? dayOf(Math.max(...apps.map(batchTime))) : null;
  const lists: Record<Tab, Item[]> = {
    latest: apps.filter((a) => dayOf(batchTime(a)) === latestDay),
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
      hint: latestDay ? `Found by the last search run, on ${new Date(latestDay).toLocaleDateString()}.` : "",
    },
    { id: "review", label: "To review", hint: "Every offer you haven't decided on yet." },
    { id: "interested", label: "Interested", hint: "Offers you're interested in or working on." },
  ];

  return (
    <div className="mt-4">
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border">
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
        <p className="mt-4 rounded-xl border border-border bg-card p-5 text-muted">
          {apps.length === 0 ? empty : tab === "interested" ? "Mark offers as interesting to keep them here." : "Nothing here."}
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
    <div className="rounded-xl border border-border bg-card p-5">
      <Link href={`/applications/${a.id}`} className="block hover:text-accent">
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
        {a.matchReason && <p className="mt-2 line-clamp-2 text-sm text-muted">{a.matchReason}</p>}
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
