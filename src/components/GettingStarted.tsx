"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, doc, limit, onSnapshot, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { usePlan } from "@/lib/plan";
import { useI18n } from "@/lib/i18n";

type Step = { id: string; title: string; text: string; href: string; action: string; done: boolean; optional?: boolean };

/**
 * Dashboard checklist for new users, ticked off from their data as they go: CV, plan, profile, first
 * search, then Gmail (optional). Disappears once the required steps are done.
 */
export function GettingStarted() {
  const { user } = useAuth();
  const { plan, loading } = usePlan();
  const { t } = useI18n();
  const [state, setState] = useState<{ docs?: boolean; profile?: boolean; gmail?: boolean; search?: boolean }>({});

  useEffect(() => {
    if (!user) return;
    const set = (k: keyof typeof state) => (v: boolean) => setState((s) => ({ ...s, [k]: v }));
    const unsubs = [
      onSnapshot(query(collection(db, "users", user.uid, "documents"), limit(1)), (s) => set("docs")(!s.empty)),
      onSnapshot(query(collection(db, "users", user.uid, "searches"), limit(1)), (s) => set("search")(!s.empty)),
      onSnapshot(doc(db, "users", user.uid), (s) => {
        set("profile")(!!s.get("profile"));
        set("gmail")(!!s.get("gmail.email"));
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [user]);

  const ready = !loading && Object.keys(state).length === 4;
  if (!ready) return null;
  const hasPlan = !!plan?.entitlement;

  const steps: Step[] = [
    {
      id: "docs",
      title: t("Add your CV"),
      text: t("Transcripts and an old motivation letter help BAPTOU write like you."),
      href: "/profile",
      action: t("Add documents"),
      done: !!state.docs,
    },
    {
      id: "plan",
      title: t("Choose a plan"),
      text: t("BAPTOU's AI work (profile, searches, letters) needs a subscription."),
      href: "/plans",
      action: t("See plans"),
      done: hasPlan,
    },
    {
      id: "profile",
      title: t("Build your profile"),
      text: t("One click on the Profile page: BAPTOU reads your documents."),
      href: "/profile",
      action: t("Build it"),
      done: !!state.profile,
    },
    {
      id: "search",
      title: t("Start your first search"),
      text: t("An internship, a job, an alternance or a master's. BAPTOU then searches every morning."),
      href: "/applications?search=new",
      action: t("Start a search"),
      done: !!state.search,
    },
    {
      id: "gmail",
      title: t("Connect Gmail"),
      text: t("Optional: to spot people you know and replies to your applications, and to send the emails you approve."),
      href: "/profile",
      action: t("Connect"),
      done: !!state.gmail,
      optional: true,
    },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;

  if (doneCount === required.length) {
    // Set up. Only a missing plan (e.g. a pass that ended) still needs pointing out.
    return hasPlan ? null : (
      <Link href="/plans" className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-accent bg-accent/10 p-4 text-sm">
        <span>{t("Choose a plan to keep using BAPTOU's searches, letters and application forms.")}</span>
        <span className="shrink-0 font-medium text-accent">{t("See plans")} →</span>
      </Link>
    );
  }

  const next = steps.find((s) => !s.done);
  return (
    <section className="mt-6 rounded-xl border border-card-edge bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{t("Get started")}</h2>
        <p className="text-sm text-muted">{t("{done} of {total} done", { done: doneCount, total: required.length })}</p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / required.length) * 100}%` }} />
      </div>
      <ol className="mt-4 grid gap-2">
        {steps.map((s, i) => {
          const current = s === next;
          return (
            <li
              key={s.id}
              className={`flex items-start gap-3 rounded-lg p-3 text-sm ${current ? "border border-accent/50 bg-accent/5" : ""}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  s.done ? "bg-accent text-white" : current ? "border-2 border-accent text-accent" : "border border-border text-muted"
                }`}
                aria-hidden
              >
                {s.done ? "✓" : i + 1}
              </span>
              {/* On a phone the button goes under the text. */}
              <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className={`font-medium ${s.done ? "text-muted line-through" : ""}`}>
                    {s.title}
                    {s.optional && <span className="ml-1 font-normal text-muted">{t("(optional)")}</span>}
                  </p>
                  {!s.done && <p className="mt-0.5 text-muted">{s.text}</p>}
                </div>
                {!s.done && (
                  <Link
                    href={s.href}
                    className={`w-fit shrink-0 rounded-lg px-3 py-1.5 font-medium ${current ? "bg-accent text-white" : "border border-border"}`}
                  >
                    {s.action}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
