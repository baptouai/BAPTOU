"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

type UsageSummary = { month: string; spentUsd: number; limitUsd: number };

/** This month's estimated Claude spend against the user's limit (written by the server after each call). */
export function UsageMeter() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setUsage((snap.get("usageSummary") as UsageSummary) ?? null));
  }, [user]);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const spent = usage?.month === thisMonth ? usage.spentUsd : 0;
  const limit = usage?.limitUsd ?? 5;
  const pct = Math.min(100, (spent / limit) * 100);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between text-sm">
        <p className="font-medium">BAPTOU usage this month</p>
        <p className="text-muted">
          ${spent.toFixed(2)} of ${limit.toFixed(2)}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-border">
        <div className={`h-full ${pct >= 90 ? "bg-red-500" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted">
        Searches, letters and form preparation use Claude. BAPTOU stops when the limit is reached and resets on the 1st.
      </p>
    </div>
  );
}
