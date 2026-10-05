"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

type UsageSummary = { month: string; spentUsd: number; limitUsd: number; byTask?: Record<string, number> };

// Fixed order and color per task (colors follow the task, never its rank). Colors live in globals.css.
const TASKS = [
  { id: "search", label: "Internship searches" },
  { id: "letter", label: "Motivation letters" },
  { id: "form", label: "Application forms" },
  { id: "contacts", label: "Mailbox contacts" },
  { id: "ask", label: "\"Is this for me?\"" },
  { id: "email", label: "Emails" },
  { id: "profile", label: "Profile" },
] as const;

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * This month's Claude spending, like a phone's storage bar: the full width is the monthly limit,
 * each colored segment is one task's share, and the empty track is what's left.
 */
export function UsageMeter() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setUsage((snap.get("usageSummary") as UsageSummary) ?? null));
  }, [user]);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const current = usage?.month === thisMonth ? usage : null;
  return <UsageBar spent={current?.spentUsd ?? 0} limit={usage?.limitUsd ?? 5} byTask={current?.byTask} />;
}

export function UsageBar({ spent, limit, byTask }: { spent: number; limit: number; byTask?: Record<string, number> }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const tracked = TASKS.map((t) => ({ ...t, usd: byTask?.[t.id] ?? 0 }));
  // Spending recorded before the breakdown existed has no task.
  const earlier = Math.max(0, spent - tracked.reduce((s, t) => s + t.usd, 0));
  const segments = [
    ...tracked,
    { id: "earlier", label: "Before the breakdown", usd: earlier >= 0.005 ? earlier : 0 },
  ].filter((s) => s.usd > 0);

  const scale = Math.max(limit, spent); // over the limit, the bar fills completely
  const left = Math.max(0, limit - spent);

  return (
    <div className="rounded-xl border border-card-edge bg-card p-5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <p className="font-medium">BAPTOU usage this month</p>
        <p className="text-muted">
          <span className="font-medium text-foreground">{usd(spent)}</span> of {usd(limit)} ·{" "}
          {spent >= limit ? <span className="font-medium text-red-600 dark:text-red-400">limit reached</span> : `${usd(left)} left`}
        </p>
      </div>

      <div
        className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full bg-border"
        role="img"
        aria-label={`${usd(spent)} of ${usd(limit)} used this month`}
      >
        {segments.map((s) => (
          <div
            key={s.id}
            title={`${s.label}: ${usd(s.usd)} (${pct(s.usd, spent)}% of spending)`}
            onMouseEnter={() => setHovered(s.id)}
            onMouseLeave={() => setHovered(null)}
            className={`h-full first:rounded-l-full transition-opacity ${hovered && hovered !== s.id ? "opacity-40" : ""}`}
            style={{ width: `${(s.usd / scale) * 100}%`, background: `var(--task-${s.id})` }}
          />
        ))}
      </div>

      {segments.length > 0 ? (
        // One aligned list, kept narrow so each amount sits close to its label (a wide grid drifted apart).
        <ul className="mt-4 grid max-w-sm gap-y-1.5 text-sm">
          {segments.map((s) => (
            <li
              key={s.id}
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
              className="flex items-center gap-2"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `var(--task-${s.id})` }} />
              <span className="flex-1 truncate">{s.label}</span>
              <span className="w-16 text-right tabular-nums">{usd(s.usd)}</span>
              <span className="w-12 text-right tabular-nums text-muted">{pct(s.usd, spent)}%</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">Nothing used yet this month.</p>
      )}

      <p className="mt-3 text-xs text-muted">
        Percentages are shares of this month&apos;s spending. BAPTOU stops when the limit is reached and resets on the 1st.
      </p>
    </div>
  );
}
