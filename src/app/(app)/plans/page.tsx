"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import { formatPct, PLANS, refreshPlan, usePlan } from "@/lib/plan";

const createCheckout = httpsCallable<{ plan: string; returnTo: string }, { url: string }>(functions, "createCheckout");
const billingPortal = httpsCallable<{ returnTo: string }, { url: string }>(functions, "billingPortal");
const cancelSubscription = httpsCallable<{ undo?: boolean }, { endsAt: number | null }>(functions, "cancelSubscription");

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

const KIND_LABEL = {
  owner: "Owner",
  monthly: "Monthly subscription",
  annual: "Yearly subscription",
  pass: "One-month pass",
  gift: "Gifted subscription",
} as const;

export default function PlansPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <Plans />
    </Suspense>
  );
}

function Plans() {
  const checkout = useSearchParams().get("checkout");
  const [reload, setReload] = useState(0);
  const { plan, loading, spentUsd, pctOf } = usePlan(reload);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [now] = useState(() => Date.now());
  const e = plan?.entitlement;
  const paid = e && (e.kind === "monthly" || e.kind === "annual" || e.kind === "pass");
  const subscribed = e?.kind === "monthly" || e?.kind === "annual";
  // When a cancellation would take effect: the end of the yearly commitment, otherwise the end of the paid month.
  const committedUntil = e?.kind === "annual" && e.commitmentEnd && e.commitmentEnd > now ? e.commitmentEnd : null;
  const cancelDate = committedUntil ?? e?.until ?? null;

  // Back from Stripe: the plan is activated by Stripe's confirmation, a few seconds later. Ask again until it shows.
  const waiting = checkout === "success" && !loading && !paid && reload < 10;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => {
      refreshPlan();
      setReload((n) => n + 1);
    }, 2500);
    return () => clearTimeout(t);
  }, [waiting, reload]);

  async function choose(id: string) {
    setBusy(id);
    setError(null);
    try {
      const { data } = await createCheckout({ plan: id, returnTo: window.location.origin });
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(null);
    }
  }

  async function cancel(undo: boolean) {
    setBusy(undo ? "undo" : "cancel");
    setError(null);
    try {
      await cancelSubscription({ undo });
      refreshPlan();
      setReload((n) => n + 1);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function manage() {
    setBusy("portal");
    setError(null);
    try {
      const { data } = await billingPortal({ returnTo: window.location.origin });
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">Plans</h1>
      <p className="mt-1 text-muted">
        Every plan includes everything in BAPTOU and the same monthly allowance for its AI work (searches, letters,
        forms, answers). It renews on the 1st of each month.
      </p>

      {checkout === "success" && (
        <p className="mt-4 rounded-lg border border-green-600/40 bg-green-600/10 p-3 text-sm">
          {paid ? "Payment received. Your plan is active. Welcome to BAPTOU!" : "Payment received. Activating your plan…"}
        </p>
      )}
      {checkout === "cancelled" && (
        <p className="mt-4 rounded-lg border border-border p-3 text-sm text-muted">Payment cancelled. Nothing was charged.</p>
      )}

      <section className="mt-6 rounded-xl border border-card-edge bg-card p-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">Your plan</h2>
            {loading ? (
              <p className="mt-1 text-muted">Loading…</p>
            ) : e ? (
              <div className="mt-1 grid gap-1">
                <p>
                  <span className="font-medium">{KIND_LABEL[e.kind]}</span>
                  <span className="text-muted">
                    {e.endsAt
                      ? ` · ends on ${day(e.endsAt)}`
                      : e.until
                        ? ` · ${e.kind === "pass" || e.kind === "gift" ? "until" : "renews on"} ${day(e.until)}`
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
          </div>
          {paid && e?.kind !== "pass" && (
            <button onClick={manage} disabled={!!busy} className="rounded-lg border border-border px-4 py-2 disabled:opacity-50">
              {busy === "portal" ? "Opening…" : "Payment method & invoices"}
            </button>
          )}
        </div>
        {committedUntil && !e?.endsAt && (
          <p className="mt-2 text-xs text-muted">The yearly plan is committed for 12 months, until {day(committedUntil)}.</p>
        )}

        {subscribed && (
          <div className="mt-4 border-t border-border pt-4">
            {e?.endsAt ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted">
                  You cancelled your subscription. You keep full access until {day(e.endsAt)}, with no payment after that.
                </p>
                <button onClick={() => cancel(true)} disabled={!!busy} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
                  {busy === "undo" ? "Saving…" : "Keep my subscription"}
                </button>
              </div>
            ) : confirming ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                <p className="font-medium">Cancel your subscription?</p>
                <p className="mt-1 text-muted">
                  {cancelDate ? `It will end on ${day(cancelDate)}. You keep full access until then` : "It will end at the end of the current period"}
                  {committedUntil
                    ? ". Your yearly plan is committed for 12 months: the monthly payments until that date are still due, and there is none after it."
                    : ", and there will be no further payment."}{" "}
                  You&apos;ll get a confirmation by email.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button onClick={() => cancel(false)} disabled={!!busy} className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50">
                    {busy === "cancel" ? "Cancelling…" : "Confirm cancellation"}
                  </button>
                  <button onClick={() => setConfirming(false)} disabled={!!busy} className="rounded-lg border border-border px-4 py-2 disabled:opacity-50">
                    Keep my subscription
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)} className="text-muted underline-offset-2 hover:text-foreground hover:underline">
                Cancel subscription
              </button>
            )}
          </div>
        )}
      </section>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {!paid && (
        <>
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
                  onClick={() => choose(p.id)}
                  disabled={!!busy}
                  className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy === p.id ? "Opening payment…" : `Choose ${p.name.toLowerCase()}`}
                </button>
              </section>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            Prices include all taxes. Payments are handled by Stripe; BAPTOU never sees your card details.
          </p>
        </>
      )}
    </div>
  );
}
