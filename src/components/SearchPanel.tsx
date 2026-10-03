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
        {visible.map((s) => (
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
              <button onClick={() => setStatus(s.id, "stopped")} className="rounded-lg px-3 py-1.5 text-red-600">
                Stop
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SearchForm({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    name: "",
    roles: "",
    locations: "",
    workMode: "any" as Search["workMode"],
    duration: "",
    startDate: "",
    industries: "",
    languages: "",
    notes: "",
    maxPerRun: 5,
    endsOn: "", // empty = until stopped
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: k === "maxPerRun" ? Number(e.target.value) : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    const { endsOn, ...fields } = form;
    const ref = await addDoc(collection(db, "users", user.uid, "searches"), {
      ...fields,
      name: fields.name || fields.roles,
      status: "active",
      endsAt: endsOn ? Timestamp.fromDate(new Date(`${endsOn}T23:59:59`)) : null,
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
        <select value={form.maxPerRun} onChange={set("maxPerRun")} className={input}>
          {[3, 5, 8, 10].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
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
          {busy ? "Starting…" : "Start searching"}
        </button>
        <button type="button" onClick={onDone} className="rounded-lg px-4 py-2 text-muted">
          Cancel
        </button>
      </div>
    </form>
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
