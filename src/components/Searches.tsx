"use client";

import { useState } from "react";
import { addDoc, collection, doc, serverTimestamp, Timestamp, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { formatPct, usePlan } from "@/lib/plan";
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

const FREQUENCIES = [
  { days: 1, label: "Every day" },
  { days: 3, label: "Every 3 days" },
  { days: 7, label: "Every week" },
];
const frequencyLabel = (days?: number) =>
  days === 7 ? "each week" : days === 3 ? "every 3 days" : "each day";
export const kindOf = (s: Pick<Search, "kind">): SearchKind => s.kind ?? "internship";

// Wording and examples per kind of search. Each kind also has its own extra fields (see SearchForm).
const KINDS: Record<
  SearchKind,
  {
    choice: string;
    label: string;
    tab: string; // default tab name
    noun: string;
    roles: [string, string];
    locations: [string, string];
    start: [string, string];
    duration?: [string, string];
    languages?: string;
    notes: string;
  }
> = {
  internship: {
    choice: "An internship",
    label: "Internship",
    tab: "Internship",
    noun: "offers",
    roles: ["Roles or keywords *", "e.g. mechanical design intern, thermal engineering"],
    locations: ["Locations", "e.g. Milton Keynes, Paris, Remote EU"],
    start: ["Start date", "e.g. November 2026"],
    duration: ["Duration", "e.g. 6 months"],
    languages: "Working languages",
    notes: "e.g. Prefer mid-size firms, no unpaid internships",
  },
  job: {
    choice: "A job",
    label: "Job",
    tab: "Job",
    noun: "offers",
    roles: ["Roles or keywords *", "e.g. junior mechanical engineer, graduate programme"],
    locations: ["Locations", "e.g. London, Lyon, Remote EU"],
    start: ["Start date", "e.g. September 2027"],
    languages: "Working languages",
    notes: "e.g. Graduate schemes welcome, no consulting",
  },
  alternance: {
    choice: "An alternance",
    label: "Alternance",
    tab: "Alternance",
    noun: "offers",
    roles: ["Roles or keywords *", "e.g. ingénieur mécanique, bureau d'études"],
    locations: ["Locations", "e.g. Île-de-France, Lyon"],
    start: ["Start date", "e.g. September 2027"],
    duration: ["Contract length", "e.g. 2 years"],
    notes: "e.g. Less than an hour from Paris, large companies preferred",
  },
  masters: {
    choice: "A master's programme",
    label: "Master's programmes",
    tab: "Master's",
    noun: "programmes",
    roles: ["Fields or programmes *", "e.g. MSc mechanical engineering, motorsport engineering"],
    locations: ["Countries", "e.g. UK, Netherlands, Switzerland"],
    start: ["Intake", "e.g. September 2027"],
    duration: ["Programme length", "e.g. 1 to 2 years"],
    languages: "Teaching languages",
    notes: "e.g. Programmes with an industrial placement, scholarships for EU students",
  },
};

/** Small tag on a search tab saying what it looks for (internships, the default, have none). */
export const kindTag = (kind: SearchKind) => (kind === "internship" ? undefined : KINDS[kind].tab);
export const kindNoun = (kind: SearchKind) => KINDS[kind].noun;

/** The selected search, at the top of its tab: what it looks for, its last run, and its controls. */
export function SearchCard({ search: s }: { search: SearchItem }) {
  const { user } = useAuth();
  const { pctOf } = usePlan();
  const [editing, setEditing] = useState(false);

  async function setStatus(status: SearchStatus) {
    if (!user) return;
    if (status === "stopped" && !confirm(`Stop "${s.name}"? BAPTOU stops searching for it. Its offers stay in this tab.`)) return;
    await updateDoc(doc(db, "users", user.uid, "searches", s.id), { status, updatedAt: serverTimestamp() });
  }

  if (editing) return <SearchForm existing={s} onDone={() => setEditing(false)} />;

  const kind = kindOf(s);
  const masters = kind === "masters";
  return (
    <div className="rounded-xl border border-card-edge bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{KINDS[kind].label}</p>
          <p className="mt-0.5 text-sm">
            {[
              s.roles,
              s.locations || (masters ? "any country" : "anywhere"),
              s.startDate && `${masters ? "intake" : "starting"} ${s.startDate}`,
              s.duration,
              (kind === "internship" || kind === "job") && s.workMode !== "any" && s.workMode,
              s.contractType,
              kind === "job" && s.salaryMin && `from ${s.salaryMin}`,
              kind === "alternance" && s.rhythm,
              kind === "alternance" && (s.school ? `school: ${s.school}` : "school to find"),
              masters && s.tuitionBudget && `tuition ≤ ${s.tuitionBudget}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            Up to {s.maxPerRun} new {KINDS[kind].noun} {frequencyLabel(s.frequencyDays)} ·{" "}
            {s.endsAt ? `until ${s.endsAt.toDate().toLocaleDateString()}` : "until you stop it"}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs">
          {s.runState && runLabel[s.runState] ? runLabel[s.runState] : statusLabel[s.status]}
        </span>
      </div>
      {s.lastRunAt && (
        <div className="mt-3 grid gap-1 rounded-lg bg-accent/5 p-3 text-sm">
          <p>
            <span className="font-medium">Last run</span>{" "}
            <span className="text-muted">
              {s.lastRunAt.toDate().toLocaleString()} · {s.lastRunCreated ?? 0} new
              {s.lastRunCostUsd != null && ` · ${formatPct(pctOf(s.lastRunCostUsd))} of your allowance`}
              {s.status === "active" && s.nextRunAt && ` · next run ${s.nextRunAt.toDate().toLocaleDateString()}`}
            </span>
          </p>
          {/* Older summaries began with "N new offers." and could be long: keep the first sentence. */}
          {s.lastRunSummary && (
            <p className="text-muted">{s.lastRunSummary.replace(/^\d+ new offers?\.\s*/, "").split(/(?<=[.!?])\s/)[0]}</p>
          )}
        </div>
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

/**
 * Default tab name when the user leaves it empty: the kind and start date ("Internship · November 2026"),
 * numbered if that name is taken, so two tabs never read the same.
 */
export function defaultTabName(kind: SearchKind, startDate: string, taken: string[]) {
  const base = `${KINDS[kind].tab}${startDate.trim() ? ` · ${startDate.trim()}` : ""}`;
  const names = new Set(taken.map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/** Creates a search (internship, job, alternance or master's programmes), or edits `existing`. */
export function SearchForm({
  existing,
  onDone,
  onCreated,
  takenNames = [],
}: {
  existing?: SearchItem;
  onDone: () => void;
  onCreated?: (id: string) => void;
  takenNames?: string[]; // other tabs' names, to keep default names unique
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
    contractType: existing?.contractType ?? "",
    salaryMin: existing?.salaryMin ?? "",
    rhythm: existing?.rhythm ?? "",
    school: existing?.school ?? "",
    notes: existing?.notes ?? "",
    maxPerRun: existing?.maxPerRun ?? 5,
    frequencyDays: existing?.frequencyDays ?? 1,
    endsOn: toDateInput(existing?.endsAt), // empty = until stopped
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: k === "maxPerRun" || k === "frequencyDays" ? Number(e.target.value) : e.target.value }));
  const k = KINDS[form.kind];
  const { pctOf } = usePlan();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    const { endsOn, ...fields } = form;
    const endsAt = endsOn ? Timestamp.fromDate(new Date(`${endsOn}T23:59:59`)) : null;
    const name =
      fields.name.trim() ||
      (existing ? existing.name : defaultTabName(fields.kind, fields.startDate, takenNames));

    if (existing) {
      // Moving the end date into the future revives a search that had ended on its own.
      const revive = existing.status === "ended" && (!endsAt || endsAt.toMillis() > Date.now());
      await updateDoc(doc(db, "users", user.uid, "searches", existing.id), {
        ...fields,
        name,
        endsAt,
        ...(revive ? { status: "active" } : {}),
        // New criteria deserve a fresh try: run at the next morning slot, forget the back-off.
        nextRunAt: null,
        emptyStreak: 0,
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
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-card-edge bg-card p-5 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <p className="text-sm font-medium">What are you looking for?</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(KINDS) as SearchKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={!!existing}
              onClick={() => setForm((f) => ({ ...f, kind, contractType: "" }))}
              className={`rounded-lg border px-4 py-2 text-sm disabled:cursor-default ${
                form.kind === kind ? "border-accent bg-accent/10 font-medium text-accent" : "border-border text-muted"
              }`}
            >
              {KINDS[kind].choice}
            </button>
          ))}
        </div>
      </div>

      <Field label="Tab name">
        <input
          value={form.name}
          onChange={set("name")}
          placeholder={`Leave empty for “${defaultTabName(form.kind, form.startDate, takenNames)}”`}
          className={input}
        />
      </Field>
      <Field label={k.roles[0]}>
        <input required value={form.roles} onChange={set("roles")} placeholder={k.roles[1]} className={input} />
      </Field>
      <Field label={k.locations[0]}>
        <input value={form.locations} onChange={set("locations")} placeholder={k.locations[1]} className={input} />
      </Field>
      <Field label={k.start[0]}>
        <input value={form.startDate} onChange={set("startDate")} placeholder={k.start[1]} className={input} />
      </Field>
      {k.duration && (
        <Field label={k.duration[0]}>
          <input value={form.duration} onChange={set("duration")} placeholder={k.duration[1]} className={input} />
        </Field>
      )}

      {form.kind === "masters" && (
        <Field label="Tuition budget per year">
          <input value={form.tuitionBudget} onChange={set("tuitionBudget")} placeholder="e.g. €15,000" className={input} />
        </Field>
      )}
      {form.kind === "job" && (
        <>
          <Field label="Contract">
            <select value={form.contractType} onChange={set("contractType")} className={input}>
              <option value="">Any</option>
              <option value="Permanent (CDI)">Permanent (CDI)</option>
              <option value="Fixed-term (CDD)">Fixed-term (CDD)</option>
              <option value="Graduate programme">Graduate programme</option>
            </select>
          </Field>
          <Field label="Minimum salary">
            <input value={form.salaryMin} onChange={set("salaryMin")} placeholder="e.g. €38,000 a year" className={input} />
          </Field>
        </>
      )}
      {form.kind === "alternance" && (
        <>
          <Field label="Contract">
            <select value={form.contractType} onChange={set("contractType")} className={input}>
              <option value="">Either</option>
              <option value="Contrat d'apprentissage">Contrat d&apos;apprentissage</option>
              <option value="Contrat de professionnalisation">Contrat de professionnalisation</option>
            </select>
          </Field>
          <Field label="Rhythm">
            <input value={form.rhythm} onChange={set("rhythm")} placeholder="e.g. 3 weeks company / 1 week school" className={input} />
          </Field>
          <Field label="Your school">
            <input value={form.school} onChange={set("school")} placeholder="Leave empty if you still need one" className={input} />
          </Field>
        </>
      )}
      {(form.kind === "internship" || form.kind === "job") && (
        <>
          <Field label="Work mode">
            <select value={form.workMode} onChange={set("workMode")} className={input}>
              <option value="any">Any</option>
              <option value="onsite">On-site</option>
              <option value="hybrid">Hybrid</option>
              <option value="remote">Remote</option>
            </select>
          </Field>
          <Field label="Industries">
            <input value={form.industries} onChange={set("industries")} placeholder="e.g. motorsport, aerospace" className={input} />
          </Field>
        </>
      )}
      {k.languages && (
        <Field label={k.languages}>
          <input value={form.languages} onChange={set("languages")} placeholder="e.g. English, French" className={input} />
        </Field>
      )}
      <Field label="How often">
        <select value={form.frequencyDays} onChange={set("frequencyDays")} className={input}>
          {FREQUENCIES.map((f) => (
            <option key={f.days} value={f.days}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">Runs that find nothing automatically wait longer before the next one.</span>
      </Field>
      <Field label={`New ${k.noun} per run`}>
        <input type="number" min={1} max={MAX_OFFERS} value={form.maxPerRun} onChange={set("maxPerRun")} className={input} />
        <OffersCostHint offers={form.maxPerRun} frequencyDays={form.frequencyDays} pctOf={pctOf} />
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
            placeholder={k.notes}
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

// Rough cost of one run (Sonnet 5, low effort, capped browsing): a fixed part for searching plus a part
// per offer. An estimate; the real cost of each run is shown on the search after it runs.
const estimateRunUsd = (offers: number) => 0.1 + 0.03 * offers;

function OffersCostHint({
  offers,
  frequencyDays,
  pctOf,
}: {
  offers: number;
  frequencyDays: number;
  pctOf: (usd: number) => number;
}) {
  if (!offers || offers < 1) return <span className="text-xs text-muted">At least 1.</span>;
  if (offers > MAX_OFFERS) return <span className="text-xs text-red-600">At most {MAX_OFFERS} per run.</span>;
  const run = pctOf(estimateRunUsd(offers));
  const monthly = (run * 30) / (frequencyDays || 1);
  return (
    <span className={`text-xs ${monthly > 70 ? "text-amber-700 dark:text-amber-400" : "text-muted"}`}>
      {offers === RECOMMENDED_OFFERS ? "Recommended. " : `Recommended: ${RECOMMENDED_OFFERS}. `}
      About {formatPct(run)} of your monthly allowance per run, at most {formatPct(Math.min(monthly, 100))} a month
      {monthly > 70 ? ", which leaves little for letters." : "."}
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
