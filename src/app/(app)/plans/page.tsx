"use client";

import { formatPct, PLANS, usePlan } from "@/lib/plan";

const KIND_LABEL = {
  owner: "Owner",
  monthly: "Monthly subscription",
  annual: "Yearly subscription",
  pass: "One-month pass",
  gift: "Gifted subscription",
} as const;

export default function PlansPage() {
  const { plan, loading, spentUsd, pctOf } = usePlan();
  const e = plan?.entitlement;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Plans</h1>
      <p className="mt-1 text-muted">
        Every plan includes everything in BAPTOU and the same monthly allowance for its AI work (searches, letters,
        forms, answers). It renews on the 1st of each month.
      </p>

      <section className="mt-6 rounded-xl border border-card-edge bg-card p-5 text-sm">
        <h2 className="font-medium">Your plan</h2>
        {loading ? (
          <p className="mt-1 text-muted">Loading…</p>
        ) : e ? (
          <div className="mt-1 grid gap-1">
            <p>
              <span className="font-medium">{KIND_LABEL[e.kind]}</span>
              <span className="text-muted">
                {e.until
                  ? ` · ${e.cancelAtPeriodEnd || e.kind === "pass" || e.kind === "gift" ? "until" : "renews on"} ${new Date(e.until).toLocaleDateString()}`
                  : e.kind === "gift"
                    ? " · no end date"
                    : ""}
              </span>
            </p>
            <p className="text-muted">{formatPct(pctOf(spentUsd))} of this month&apos;s allowance used.</p>
          </div>
        ) : (
          <p className="mt-1 text-muted">You don&apos;t have a plan yet. Choose one below to use BAPTOU&apos;s AI features.</p>
        )}
      </section>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => (
          <section
            key={p.id}
            className={`flex flex-col rounded-xl border bg-card p-5 ${p.id === "annual" ? "border-accent" : "border-card-edge"}`}
          >
            {p.id === "annual" && (
              <span className="mb-2 w-fit rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Best price</span>
            )}
            <h2 className="font-medium">{p.name}</h2>
            <p className="mt-2">
              <span className="text-3xl font-semibold">{p.price}</span> <span className="text-sm text-muted">{p.per}</span>
            </p>
            <p className="mt-2 flex-1 text-sm text-muted">{p.detail}</p>
            <button
              disabled
              title="Payments open soon"
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Payments open soon
            </button>
          </section>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">Prices include VAT.</p>
    </div>
  );
}
