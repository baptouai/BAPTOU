"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import { formatPct, PLANS, refreshPlan, usePlan } from "@/lib/plan";
import { errorText, useI18n } from "@/lib/i18n";

const createCheckout = httpsCallable<{ plan: string; returnTo: string }, { url: string }>(functions, "createCheckout");
const billingPortal = httpsCallable<{ returnTo: string }, { url: string }>(functions, "billingPortal");
const cancelSubscription = httpsCallable<{ undo?: boolean }, { endsAt: number | null }>(functions, "cancelSubscription");

const KIND_LABEL = {
  owner: "Owner",
  monthly: "Monthly subscription",
  annual: "Yearly subscription",
  pass: "One-month pass",
  gift: "Gifted subscription",
} as const;

export default function PlansPage() {
  return (
    <Suspense fallback={null}>
      <Plans />
    </Suspense>
  );
}

function Plans() {
  const checkout = useSearchParams().get("checkout");
  const { t, date } = useI18n();
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
    const timer = setTimeout(() => {
      refreshPlan();
      setReload((n) => n + 1);
    }, 2500);
    return () => clearTimeout(timer);
  }, [waiting, reload]);

  async function choose(id: string) {
    setBusy(id);
    setError(null);
    try {
      const { data } = await createCheckout({ plan: id, returnTo: window.location.origin });
      window.location.assign(data.url);
    } catch (err) {
      setError(errorText(err, t));
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
      setError(errorText(err, t));
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
      setError(errorText(err, t));
      setBusy(null);
    }
  }

  // What the plan line says after the plan's name.
  const planEnd = !e
    ? ""
    : e.endsAt
      ? t("ends on {date}", { date: date(e.endsAt) })
      : e.until
        ? t(e.kind === "pass" || e.kind === "gift" ? "until {date}" : "renews on {date}", { date: date(e.until) })
        : e.kind === "gift"
          ? t("no end date")
          : "";

  const cancelText = !cancelDate
    ? t("It will end at the end of the current period, and there will be no further payment. You'll get a confirmation by email.")
    : committedUntil
      ? t(
          "It will end on {date}. You keep full access until then. Your yearly plan is committed for 12 months: the monthly payments until that date are still due, and there is none after it. You'll get a confirmation by email.",
          { date: date(cancelDate) },
        )
      : t("It will end on {date}. You keep full access until then, and there will be no further payment. You'll get a confirmation by email.", {
          date: date(cancelDate),
        });

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("Plans")}</h1>
      <p className="mt-1 text-muted">
        {t(
          "Every plan includes everything in BAPTOU and the same monthly allowance for its AI work (searches, letters, forms, answers). It renews on the 1st of each month.",
        )}
      </p>

      {checkout === "success" && (
        <p className="mt-4 rounded-lg border border-green-600/40 bg-green-600/10 p-3 text-sm">
          {t(paid ? "Payment received. Your plan is active. Welcome to BAPTOU!" : "Payment received. Activating your plan…")}
        </p>
      )}
      {checkout === "cancelled" && (
        <p className="mt-4 rounded-lg border border-border p-3 text-sm text-muted">{t("Payment cancelled. Nothing was charged.")}</p>
      )}

      <section className="mt-6 rounded-xl border border-card-edge bg-card p-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">{t("Your plan")}</h2>
            {loading ? (
              <p className="mt-1 text-muted">{t("Loading…")}</p>
            ) : e ? (
              <div className="mt-1 grid gap-1">
                <p>
                  <span className="font-medium">{t(KIND_LABEL[e.kind])}</span>
                  {planEnd && <span className="text-muted"> · {planEnd}</span>}
                </p>
                <p className="text-muted">{t("{pct} of this month's allowance used.", { pct: formatPct(pctOf(spentUsd)) })}</p>
              </div>
            ) : (
              <p className="mt-1 text-muted">{t("You don't have a plan yet. Choose one below to start using BAPTOU.")}</p>
            )}
          </div>
          {paid && e?.kind !== "pass" && (
            <button onClick={manage} disabled={!!busy} className="rounded-lg border border-border px-4 py-2 disabled:opacity-50">
              {t(busy === "portal" ? "Opening…" : "Payment method & invoices")}
            </button>
          )}
        </div>
        {committedUntil && !e?.endsAt && (
          <p className="mt-2 text-xs text-muted">
            {t("The yearly plan is committed for 12 months, until {date}.", { date: date(committedUntil) })}
          </p>
        )}

        {subscribed && (
          <div className="mt-4 border-t border-border pt-4">
            {e?.endsAt ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted">
                  {t("You cancelled your subscription. You keep full access until {date}, with no payment after that.", {
                    date: date(e.endsAt),
                  })}
                </p>
                <button onClick={() => cancel(true)} disabled={!!busy} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
                  {t(busy === "undo" ? "Saving…" : "Keep my subscription")}
                </button>
              </div>
            ) : confirming ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                <p className="font-medium">{t("Cancel your subscription?")}</p>
                <p className="mt-1 text-muted">{cancelText}</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button onClick={() => cancel(false)} disabled={!!busy} className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50">
                    {t(busy === "cancel" ? "Cancelling…" : "Confirm cancellation")}
                  </button>
                  <button onClick={() => setConfirming(false)} disabled={!!busy} className="rounded-lg border border-border px-4 py-2 disabled:opacity-50">
                    {t("Keep my subscription")}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)} className="text-muted underline-offset-2 hover:text-foreground hover:underline">
                {t("Cancel subscription")}
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
              <section key={p.id} className={`plan-card plan-${p.id} flex flex-col rounded-xl p-5`}>
                {p.id === "annual" && (
                  <span className="plan-badge mb-2 w-fit rounded-full px-2 py-0.5 text-xs font-semibold">{t("Best price")}</span>
                )}
                <h2 className="plan-name w-fit font-semibold">{t(p.name)}</h2>
                <p className="mt-2">
                  <s className="block text-sm text-muted">{p.was}</s>
                  <span className="text-3xl font-semibold">{p.price}</span> <span className="text-sm text-muted">{t(p.per)}</span>
                </p>
                <p className="mt-2 flex-1 text-sm text-muted">{t(p.detail)}</p>
                <button
                  onClick={() => choose(p.id)}
                  disabled={!!busy}
                  className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t(busy === p.id ? "Opening payment…" : "Choose this plan")}
                </button>
              </section>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {t("Prices include all taxes. Payments are handled by Stripe; BAPTOU never sees your card details.")}
          </p>
        </>
      )}
    </div>
  );
}
