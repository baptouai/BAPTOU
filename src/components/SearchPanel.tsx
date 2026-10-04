"use client";

import { useEffect, useState } from "react";
import {
  addDoc, collection, doc, onSnapshot, orderBy, query, serverTimestamp, Timestamp, updateDoc,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { Search, SearchStatus } from "@/lib/types";

const runSearchNow = httpsCallable<{ searchId: string }, { queued: boolean }>(functions, "runSearchNow");

const statusLabel: Record<SearchStatus, string> = {
  active: "Searching daily",
  paused: "Paused",
  stopped: "Stopped",
  ended: "Ended",
};

const runLabel = { queued: "Queued…", running: "Searching now…", idle: "", error: "" } as const;

export function SearchPanel() {
  const { user } = useAuth();
  const [searches, setSearches] = useState<(Search & { id: string })[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "searches"), orderBy("createdAt", "desc"));
    return onSnapshot(q, (snap) => setSearches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Search) }))));
  }, [user]);

  async function setStatus(id: string, status: SearchStatus) {
    if (!user) return;
    await updateDoc(doc(db, "users", user.uid, "searches", id), { status, updatedAt: serverTimestamp() });
  }

  const visible = searches.filter((s) => s.status !== "stopped");

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Your searches</h2>
          <p className="text-sm text-muted">
            BAPTOU only searches while a search is active, once a day around 7:00 (Paris time).
          </p>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="rounded-lg bg-accent px-4 py-2 font-medium text-white">
            New search
          </button>
        )}
      </div>

      {showForm && <SearchForm onDone={() => setShowForm(false)} />}

      <ul className="mt-4 grid gap-3">
        {visible.length === 0 && !showForm && (
          <li className="text-sm text-muted">No search yet. Create one to start receiving internship suggestions.</li>
        )}
        {visible.map((s) =>
          editingId === s.id ? (
            <li key={s.id}>
              <SearchForm existing={s} onDone={() => setEditingId(null)} />
            </li>
          ) : (
          <li key={s.id} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{s.name}</p>
                <p className="text-sm text-muted">
                  {s.roles} · {s.locations || "anywhere"} · {s.workMode}
                  {s.endsAt ? ` · until ${s.endsAt.toDate().toLocaleDateString()}` : " · until you stop it"}
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
                  <button onClick={() => setStatus(s.id, "paused")} className="rounded-lg border border-border px-3 py-1.5">
                    Pause
                  </button>
                </>
              )}
              {(s.status === "paused" || s.status === "ended") && (
                <button onClick={() => setStatus(s.id, "active")} className="rounded-lg border border-border px-3 py-1.5">
                  Resume
                </button>
              )}
              <button onClick={() => setEditingId(s.id)} className="rounded-lg border border-border px-3 py-1.5">
                Edit
              </button>
              <button onClick={() => setStatus(s.id, "stopped")} className="rounded-lg px-3 py-1.5 text-red-600">
                Stop
              </button>
            </div>
          </li>
          ),
        )}
      </ul>
    </section>
  );
}

const toDateInput = (t: Timestamp | null | undefined) => {
  if (!t) return "";
  const d = t.toDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Creates a new search, or edits `existing`. Changes apply from the next run. */
function SearchForm({ existing, onDone }: { existing?: Search & { id: string }; onDone: () => void }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    name: existing?.name ?? "",
    roles: existing?.roles ?? "",
    locations: existing?.locations ?? "",
    workMode: existing?.workMode ?? ("any" as Search["workMode"]),
    duration: existing?.duration ?? "",
    startDate: existing?.startDate ?? "",
    industries: existing?.industries ?? "",
    languages: existing?.languages ?? "",
    notes: existing?.notes ?? "",
    maxPerRun: existing?.maxPerRun ?? 5,
    endsOn: toDateInput(existing?.endsAt), // empty = until stopped
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: k === "maxPerRun" ? Number(e.target.value) : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    const { endsOn, ...fields } = form;
    const endsAt = endsOn ? Timestamp.fromDate(new Date(`${endsOn}T23:59:59`)) : null;

    if (existing) {
      // Moving the end date into the future revives a search that had ended on its own.
      const revive = existing.status === "ended" && (!endsAt || endsAt.toMillis() > Date.now());
      await updateDoc(doc(db, "users", user.uid, "searches", existing.id), {
        ...fields,
        name: fields.name || fields.roles,
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
      name: fields.name || fields.roles,
      status: "active",
      endsAt,
      runState: "idle",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await runSearchNow({ searchId: ref.id }).catch(() => {});
    setBusy(false);
    onDone();
  }

  const input = "rounded-lg border border-border bg-background px-3 py-2";

  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
      <Field label="Roles or keywords *">
        <input required value={form.roles} onChange={set("roles")} placeholder="e.g. M&A analyst intern, corporate finance" className={input} />
      </Field>
      <Field label="Name (optional)">
        <input value={form.name} onChange={set("name")} placeholder="e.g. Finance internships London" className={input} />
      </Field>
      <Field label="Locations">
        <input value={form.locations} onChange={set("locations")} placeholder="e.g. London, Paris, Remote EU" className={input} />
      </Field>
      <Field label="Work mode">
        <select value={form.workMode} onChange={set("workMode")} className={input}>
          <option value="any">Any</option>
          <option value="onsite">On-site</option>
          <option value="hybrid">Hybrid</option>
          <option value="remote">Remote</option>
        </select>
      </Field>
      <Field label="Duration">
        <input value={form.duration} onChange={set("duration")} placeholder="e.g. 6 months" className={input} />
      </Field>
      <Field label="Start date">
        <input value={form.startDate} onChange={set("startDate")} placeholder="e.g. January 2027" className={input} />
      </Field>
      <Field label="Industries">
        <input value={form.industries} onChange={set("industries")} placeholder="e.g. banking, consulting" className={input} />
      </Field>
      <Field label="Working languages">
        <input value={form.languages} onChange={set("languages")} placeholder="e.g. English, French" className={input} />
      </Field>
      <Field label="New offers per day">
        <input
          type="number"
          min={1}
          max={MAX_OFFERS}
          value={form.maxPerRun}
          onChange={set("maxPerRun")}
          className={input}
        />
        <OffersCostHint offers={form.maxPerRun} />
      </Field>
      <Field label="Search until">
        <input type="date" value={form.endsOn} onChange={set("endsOn")} className={input} />
        <span className="text-xs text-muted">Leave empty to search until you stop it.</span>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Anything else BAPTOU should know">
          <textarea value={form.notes} onChange={set("notes")} rows={3} placeholder="e.g. Prefer mid-size firms, no unpaid internships" className={input} />
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
