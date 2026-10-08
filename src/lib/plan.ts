"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

// Prices (VAT included) for the three contracts: €10 of AI per month + margin + payment fees + 20% VAT.
// Shown on the Plans page; the amounts actually charged are set on the Stripe prices.
export const PLANS = [
  {
    id: "monthly",
    name: "Monthly",
    price: "€18.99",
    per: "per month",
    detail: "Renews every month. Cancel anytime.",
  },
  {
    id: "annual",
    name: "Yearly",
    price: "€16.49",
    per: "per month, for 12 months",
    detail: "The best price, paid monthly. 12-month commitment.",
  },
  {
    id: "pass",
    name: "One month",
    price: "€18.99",
    per: "once",
    detail: "One month of BAPTOU, no renewal.",
  },
] as const;

export type Entitlement = {
  kind: "owner" | "monthly" | "annual" | "pass" | "gift";
  budgetUsd: number;
  until: number | null;
  cancelAtPeriodEnd?: boolean;
  endsAt?: number | null; // set once the subscription is cancelled
  commitmentEnd?: number | null; // yearly plan
};

// `failed`: the server couldn't be asked (offline…). That is not "no plan": the app isn't locked for it.
type PlanInfo = { entitlement: Entitlement | null; gmailRead: boolean; budgetUsd: number; failed?: boolean };

const myPlan = httpsCallable<void, PlanInfo>(functions, "myPlan");

// One request per user and page load, shared by every component that needs the plan.
let cache: { uid: string; promise: Promise<PlanInfo> } | null = null;
function loadPlan(uid: string) {
  if (cache?.uid !== uid) {
    cache = {
      uid,
      promise: myPlan()
        .then(({ data }) => data)
        .catch(() => {
          cache = null; // ask again next time
          return { entitlement: null, gmailRead: false, budgetUsd: 11, failed: true };
        }),
    };
  }
  return cache.promise;
}

const listeners = new Set<() => void>();

/** Forgets the cached plan (e.g. after a payment) and has every usePlan() ask the server again. */
export function refreshPlan() {
  cache = null;
  listeners.forEach((l) => l());
}

/** The user's plan (from the server) and this month's usage as a share of the allowance. */
export function usePlan(reloadKey = 0) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [spentUsd, setSpentUsd] = useState(0);
  const [byTask, setByTask] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    loadPlan(user.uid).then(setPlan);
    const thisMonth = new Date().toISOString().slice(0, 7);
    return onSnapshot(doc(db, "users", user.uid), (snap) => {
      const u = snap.get("usageSummary") as { month: string; spentUsd: number; byTask?: Record<string, number> } | undefined;
      setSpentUsd(u?.month === thisMonth ? u.spentUsd : 0);
      setByTask(u?.month === thisMonth ? (u.byTask ?? {}) : {});
    });
  }, [user, reloadKey, version]);

  const budget = plan?.entitlement?.budgetUsd ?? plan?.budgetUsd ?? 11;
  return {
    plan,
    loading: !plan,
    budgetUsd: budget,
    spentUsd,
    byTask,
    /** Share of the monthly allowance, in % (0-100+). */
    pctOf: (usd: number) => (budget > 0 ? (usd / budget) * 100 : 0),
  };
}

/** "4%", "<1%", "100%" */
export function formatPct(pct: number) {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
