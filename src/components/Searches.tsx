"use client";

import { useState } from "react";
import { addDoc, collection, doc, serverTimestamp, Timestamp, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { Search, SearchKind, SearchStatus } from "@/lib/types";

const runSearchNow = httpsCallable<{ searchId: string }, { queued: boolean }>(functions, "runSearchNow");

const statusLabel: Record<SearchStatus, string> = {
  active: "Searching daily",
  paused: "Paused",
  stopped: "Stopped",
  ended: "Ended",
};
const runLabel = { queued: "Queued…", running: "Searching now…", idle: "", error: "" } as const;

export type SearchItem = Search & { id: string };
export const kindOf = (s: Pick<Search, "kind">): SearchKind => s.kind ?? "internship";

/** The selected search, at the top of its tab: what it looks for, its last run, and its controls. */
export function SearchCard({ search: s }: { search: SearchItem }) {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);

  async function setStatus(status: SearchStatus) {
    if (!user) return;
    if (status === "stopped" && !confirm(`Stop "${s.name}"? BAPTOU stops searching for it. Its offers stay in this tab.`)) return;
    await updateDoc(doc(db, "users", user.uid, "searches", s.id), { status, updatedAt: serverTimestamp() });
  }

  if (editing) return <SearchForm existing={s} onDone={() => setEditing(false)} />;

  const masters = kindOf(s) === "masters";
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {masters ? "Master's programmes" : "Internship"}
          </p>
          <p className="mt-0.5 text-sm">
            {[
              s.roles,
              s.locations || (masters ? "any country" : "anywhere"),
              s.startDate && `${masters ? "intake" : "starting"} ${s.startDate}`,
              s.duration,
              !masters && s.workMode !== "any" && s.workMode,
              masters && s.tuitionBudget && `tuition ≤ ${s.tuitionBudget}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {s.maxPerRun} new {masters ? "programmes" : "offers"} a day ·{" "}
            {s.endsAt ? `until ${s.endsAt.toDate().toLocaleDateString()}` : "until you stop it"}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs">
          {s.runState && runLabel[s.runState] ? runLabel[s.runState] : statusLabel[s.status]}
        </span>
      </div>
      {s.lastRunSummary && (
        <p className="mt-2 text-sm text-muted">
          Last run {s.lastRunAt?.toDate().toLocaleString()}: {s.lastRunSummary}
        </p>
      )}
      {s.runState === "error" && s.lastError && <p className="mt-2 text-sm text-red-600">{s.lastError}</p>}
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        {s.status === "active" && (
          <>
            <button
              onClick={() => runSearchNow({ searchId: s.id })}
              disabled={s.runState === "queued" || s.runState === "running"}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-50"
            >
              Search now
            </button>
            <button onClick={() => setStatus("paused")} className="rounded-lg border border-border px-3 py-1.5">
              Pause
            </button>
          </>
        )}
        {s.status !== "active" && (
          <button onClick={() => setStatus("active")} className="rounded-lg border border-border px-3 py-1.5">
            Resume
          </button>
        )}
        <button onClick={() => setEditing(true)} className="rounded-lg border border-border px-3 py-1.5">
          Edit
        </button>
        {s.status !== "stopped" && (
          <button onClick={() => setStatus("stopped")} className="rounded-lg px-3 py-1.5 text-red-600">
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

const toDateInput = (t: Timestamp | null | undefined) => {
  if (!t) return "";
  const d = t.toDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Creates a search (internship or master's programmes), or edits `existing`. Changes apply from the next run. */
export function SearchForm({
  existing,
  onDone,
  onCreated,
}: {
  existing?: SearchItem;
  onDone: () => void;
  onCreated?: (id: string) => void;
}) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    kind: existing ? kindOf(existing) : ("internship" as SearchKind),
    name: existing?.name ?? "",
    roles: existing?.roles ?? "",
    locations: existing?.locations ?? "",
    workMode: existing?.workMode ?? ("any" as Search["workMode"]),
    duration: existing?.duration ?? "",
    startDate: existing?.startDate ?? "",
    industries: existing?.industries ?? "",
    languages: existing?.languages ?? "",
    tuitionBudget: existing?.tuitionBudget ?? "",
    notes: existing?.notes ?? "",
    maxPerRun: existing?.maxPerRun ?? 5,
    endsOn: toDateInput(existing?.endsAt), // empty = until stopped
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: k === "maxPerRun" ? Number(e.target.value) : e.target.value }));
  const masters = form.kind === "masters";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    const { endsOn, ...fields } = form;
    const endsAt = endsOn ? Timestamp.fromDate(new Date(`${endsOn}T23:59:59`)) : null;
    const name = fields.name.trim() || fields.roles;

    if (existing) {
      // Moving the end date into the future revives a search that had ended on its own.
      const revive = existing.status === "ended" && (!endsAt || endsAt.toMillis() > Date.now());
      await updateDoc(doc(db, "users", user.uid, "searches", existing.id), {
        ...fields,
        name,
        endsAt,
        ...(revive ? { status: "active" } : {}),
        updatedAt: serverTimestamp(),
      });
      setBusy(false);
      onDone();
      return;
    }

    const ref = await addDoc(collection(db, "users", user.uid, "searches"), {
      ...fields,
      name,
      status: "active",
      endsAt,
      runState: "idle",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await runSearchNow({ searchId: ref.id }).catch(() => {});
    setBusy(false);
    // A new search opens its own tab; onDone is for closing the form (cancel / after editing).
    if (onCreated) onCreated(ref.id);
    else onDone();
  }

  const input = "rounded-lg border border-border bg-background px-3 py-2";

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-border bg-card p-5 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <p className="text-sm font-medium">What are you looking for?</p>
        <div className="mt-2 flex gap-2">
          {(["internship", "masters"] as const).map((k) => (
            <button
              key={k}
              type="button"
              disabled={!!existing}
              onClick={() => setForm((f) => ({ ...f, kind: k }))}
              className={`rounded-lg border px-4 py-2 text-sm disabled:cursor-default ${
                form.kind === k ? "border-accent bg-accent/10 font-medium text-accent" : "border-border text-muted"
              }`}
            >
              {k === "internship" ? "An internship" : "A master's programme"}
            </button>
          ))}
        </div>
      </div>

      <Field label="Tab name">
        <input
          value={form.name}
          onChange={set("name")}
          placeholder={masters ? "e.g. Masters 2027" : "e.g. November internship"}
          className={input}
        />
      </Field>
      <Field label={masters ? "Fields or programmes *" : "Roles or keywords *"}>
        <input
          required
          value={form.roles}
          onChange={set("roles")}
          placeholder={masters ? "e.g. MSc mechanical engineering, motorsport engineering" : "e.g. mechanical design intern, thermal engineering"}
          className={input}
        />
      </Field>
      <Field label={masters ? "Countries" : "Locations"}>
        <input
          value={form.locations}
          onChange={set("locations")}
          placeholder={masters ? "e.g. UK, Netherlands, Switzerland" : "e.g. Milton Keynes, Paris, Remote EU"}
          className={input}
        />
      </Field>
      <Field label={masters ? "Intake" : "Start date"}>
        <input
          value={form.startDate}
          onChange={set("startDate")}
          placeholder={masters ? "e.g. September 2027" : "e.g. November 2026"}
          className={input}
        />
      </Field>
      <Field label={masters ? "Programme length" : "Duration"}>
        <input value={form.duration} onChange={set("duration")} placeholder={masters ? "e.g. 1 to 2 years" : "e.g. 6 months"} className={input} />
      </Field>
      {masters ? (
        <Field label="Tuition budget per year">
          <input value={form.tuitionBudget} onChange={set("tuitionBudget")} placeholder="e.g. €15,000" className={input} />
        </Field>
      ) : (
        <Field label="Work mode">
          <select value={form.workMode} onChange={set("workMode")} className={input}>
            <option value="any">Any</option>
            <option value="onsite">On-site</option>
            <option value="hybrid">Hybrid</option>
            <option value="remote">Remote</option>
          </select>
        </Field>
      )}
      {!masters && (
        <Field label="Industries">
          <input value={form.industries} onChange={set("industries")} placeholder="e.g. motorsport, aerospace" className={input} />
        </Field>
      )}
      <Field label={masters ? "Teaching languages" : "Working languages"}>
        <input value={form.languages} onChange={set("languages")} placeholder="e.g. English, French" className={input} />
      </Field>
      <Field label={masters ? "New programmes per day" : "New offers per day"}>
        <input type="number" min={1} max={MAX_OFFERS} value={form.maxPerRun} onChange={set("maxPerRun")} className={input} />
        <OffersCostHint offers={form.maxPerRun} />
      </Field>
      <Field label="Search until">
        <input type="date" value={form.endsOn} onChange={set("endsOn")} className={input} />
        <span className="text-xs text-muted">Leave empty to search until you stop it.</span>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Anything else BAPTOU should know">
          <textarea
            value={form.notes}
            onChange={set("notes")}
            rows={3}
            placeholder={masters ? "e.g. Programmes with an industrial placement, scholarships for EU students" : "e.g. Prefer mid-size firms, no unpaid internships"}
            className={input}
          />
        </Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
          {existing ? (busy ? "Saving…" : "Save changes") : busy ? "Starting…" : "Start searching"}
        </button>
        <button type="button" onClick={onDone} className="rounded-lg px-4 py-2 text-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}

const RECOMMENDED_OFFERS = 5;
const MAX_OFFERS = 50; // the server also caps here; guards against typos like 500

// Rough cost of one daily run on Sonnet 5 with capped browsing: a fixed part for searching plus a part
// per offer (reading the posting, writing the match reason). An estimate, refined as real usage comes in.
const estimateMonthlyUsd = (offers: number) => 30 * (0.08 + 0.025 * offers);

function OffersCostHint({ offers }: { offers: number }) {
  if (!offers || offers < 1) return <span className="text-xs text-muted">At least 1.</span>;
  if (offers > MAX_OFFERS) return <span className="text-xs text-red-600">At most {MAX_OFFERS} per day.</span>;
  const monthly = estimateMonthlyUsd(offers);
  return (
    <span className={`text-xs ${monthly > 8 ? "text-amber-700 dark:text-amber-400" : "text-muted"}`}>
      {offers === RECOMMENDED_OFFERS ? "Recommended. " : `Recommended: ${RECOMMENDED_OFFERS}. `}
      About ${monthly.toFixed(0)}/month if it runs every day
      {monthly > 8 ? ", which leaves little of a $10 budget for letters." : "."}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
