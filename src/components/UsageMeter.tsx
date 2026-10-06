"use client";

import { useState } from "react";
import { formatPct, usePlan } from "@/lib/plan";
import { useI18n } from "@/lib/i18n";

// Fixed order and color per task (colors follow the task, never its rank). Colors live in globals.css.
const TASKS = [
  { id: "search", label: "Searches" },
  { id: "letter", label: "Motivation letters" },
  { id: "form", label: "Application forms" },
  { id: "contacts", label: "Mailbox contacts" },
  { id: "ask", label: "\"Is this for me?\"" },
  { id: "email", label: "Emails" },
  { id: "profile", label: "Profile" },
  { id: "replies", label: "Reply checks" },
] as const;

/** This month's usage as a share of the monthly allowance (users never see amounts of money). */
export function UsageMeter() {
  const { spentUsd, byTask, budgetUsd } = usePlan();
  return <UsageBar spent={spentUsd} limit={budgetUsd} byTask={byTask} />;
}

/**
 * Like a phone's storage bar: the full width is 100% of the monthly allowance, each colored segment is
 * one task's share of it, and the empty track is what's left.
 */
export function UsageBar({ spent, limit, byTask }: { spent: number; limit: number; byTask?: Record<string, number> }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const { t } = useI18n();
  const pct = (usd: number) => (limit > 0 ? (usd / limit) * 100 : 0);

  const tracked = TASKS.map((t) => ({ ...t, usd: byTask?.[t.id] ?? 0 }));
  // Usage recorded before the breakdown existed has no task.
  const earlier = Math.max(0, spent - tracked.reduce((s, t) => s + t.usd, 0));
  const segments = [
    ...tracked,
    { id: "earlier", label: "Before the breakdown", usd: earlier >= 0.005 ? earlier : 0 },
  ].filter((s) => s.usd > 0);

  const used = pct(spent);
  const scale = Math.max(limit, spent); // over the allowance, the bar fills completely

  return (
    <div className="rounded-xl border border-card-edge bg-card p-5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <p className="font-medium">{t("Your allowance this month")}</p>
        <p className="text-muted">
          {used >= 100 ? (
            <span className="font-medium text-red-600 dark:text-red-400">{t("100% used")}</span>
          ) : (
            <>
              <span className="font-medium text-foreground">{formatPct(used)}</span> {t("used")} ·{" "}
              {formatPct(Math.max(0, 100 - used))} {t("left")}
            </>
          )}
        </p>
      </div>

      <div
        className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full bg-border"
        role="img"
        aria-label={t("{pct} of this month's allowance used", { pct: formatPct(used) })}
      >
        {segments.map((s) => (
          <div
            key={s.id}
            title={t("{task}: {pct} of your allowance", { task: t(s.label), pct: formatPct(pct(s.usd)) })}
            onMouseEnter={() => setHovered(s.id)}
            onMouseLeave={() => setHovered(null)}
            className={`h-full first:rounded-l-full transition-opacity ${hovered && hovered !== s.id ? "opacity-40" : ""}`}
            style={{ width: `${(s.usd / scale) * 100}%`, background: `var(--task-${s.id})` }}
          />
        ))}
      </div>

      {segments.length > 0 ? (
        // One aligned list, kept narrow so each value sits close to its label.
        <ul className="mt-4 grid max-w-xs gap-y-1.5 text-sm">
          {segments.map((s) => (
            <li
              key={s.id}
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
              className="flex items-center gap-2"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `var(--task-${s.id})` }} />
              <span className="flex-1 truncate">{t(s.label)}</span>
              <span className="w-12 text-right tabular-nums">{formatPct(pct(s.usd))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">{t("Nothing used yet this month.")}</p>
      )}

      <p className="mt-3 text-xs text-muted">
        {t("Percentages are shares of your monthly allowance. It renews on the 1st of each month.")}
      </p>
    </div>
  );
}
