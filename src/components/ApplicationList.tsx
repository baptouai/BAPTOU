"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { verdictLabel } from "@/components/FitCheck";
import type { Application, ApplicationType } from "@/lib/types";

export const statusLabel: Record<Application["status"], string> = {
  suggested: "Suggested",
  editing: "Editing",
  approved: "Approved",
  applied: "Applied",
  rejected: "Rejected",
  dismissed: "Dismissed",
};

export function ApplicationList({ type, empty }: { type: ApplicationType; empty: string }) {
  const { user } = useAuth();
  const [apps, setApps] = useState<(Application & { id: string })[] | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "users", user.uid, "applications"),
      where("type", "==", type),
      orderBy("updatedAt", "desc"),
    );
    return onSnapshot(q, (snap) =>
      setApps(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Application) }))),
    );
  }, [user, type]);

  if (!apps) return <p className="mt-6 text-muted">Loading…</p>;
  const dismissedCount = apps.filter((a) => a.status === "dismissed").length;
  const visible = showDismissed ? apps : apps.filter((a) => a.status !== "dismissed");

  return (
    <>
    {visible.length === 0 && <p className="mt-6 rounded-xl border border-border bg-card p-5 text-muted">{empty}</p>}
    <ul className="mt-6 grid gap-3">
      {visible.map((a) => (
        <li key={a.id}>
          <Link
            href={`/applications/${a.id}`}
            className={`block rounded-xl border border-border bg-card p-5 hover:border-accent ${a.status === "dismissed" ? "opacity-60" : ""}`}
          >
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
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                    {a.matchScore}% match
                  </span>
                )}
                <span className="rounded-full border border-border px-2 py-0.5 text-xs">{statusLabel[a.status]}</span>
              </div>
            </div>
            {a.status === "dismissed" && a.dismissReason ? (
              <p className="mt-2 line-clamp-2 text-sm text-muted">Dismissed: {a.dismissReason}</p>
            ) : (
              a.matchReason && <p className="mt-2 line-clamp-2 text-sm text-muted">{a.matchReason}</p>
            )}
          </Link>
        </li>
      ))}
    </ul>
    {dismissedCount > 0 && (
      <button onClick={() => setShowDismissed((v) => !v)} className="mt-3 text-sm text-muted">
        {showDismissed ? "Hide dismissed" : `Show dismissed (${dismissedCount})`}
      </button>
    )}
    </>
  );
}
