"use client";

import { useEffect, useRef, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref } from "firebase/storage";
import { db, functions, storage } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { ApplicationForm, FormEntry, FormField, UploadedDocument } from "@/lib/types";

const prepareApplication = httpsCallable<{ applicationId: string }, ApplicationForm | null>(functions, "prepareApplication", {
  timeout: 540_000,
});

const COVER_LETTER_LABEL = /cover(ing)? letter|motivation letter|lettre de motivation|anschreiben|carta de presentaci/i;

/** The form field asking for the cover/motivation letter, if any. Older forms lack the flag, so the label is checked too. */
export function coverLetterField(form: ApplicationForm | undefined): FormField | undefined {
  const fields = form?.sections.flatMap((s) => s.fields) ?? [];
  return (
    fields.find((f) => f.isCoverLetter) ??
    fields.find((f) => f.isCoverLetter === undefined && (f.kind === "long_text" || f.kind === "file") && COVER_LETTER_LABEL.test(f.label))
  );
}

/**
 * The application laid out like the organization's real form, every field prepared and editable.
 * Edits are passed to `onChange`, which autosaves them.
 */
export function ApplicationFormView({
  applicationId, form, status, statusError, autoPrepare, letter, title, onChange,
}: {
  applicationId: string;
  form: ApplicationForm | undefined;
  status: "preparing" | "ready" | "error" | undefined;
  statusError: string | undefined;
  autoPrepare: boolean; // prepare on first open, without waiting for a click
  letter: string;
  title: string;
  onChange: (form: ApplicationForm) => void;
}) {
  const { user } = useAuth();
  const [local, setLocal] = useState(form);
  const [docs, setDocs] = useState<(UploadedDocument & { id: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Take the server's version when BAPTOU (re)prepares the form.
  const preparedAt = form?.preparedAt?.toMillis();
  const [seenPreparedAt, setSeenPreparedAt] = useState(preparedAt);
  if (preparedAt !== seenPreparedAt) {
    setSeenPreparedAt(preparedAt);
    setLocal(form);
  }

  useEffect(() => {
    if (!user) return;
    getDocs(collection(db, "users", user.uid, "documents")).then((snap) =>
      setDocs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UploadedDocument) }))),
    );
  }, [user]);

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await prepareApplication({ applicationId });
      if (data) setLocal(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // First time an offer is opened, prepare its form straight away. The server records the run's
  // status, so reloading or reopening the offer shows progress instead of starting again.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoPrepare || form || status || autoStarted.current) return;
    autoStarted.current = true;
    prepareApplication({ applicationId }).catch((e) =>
      setError(e instanceof Error ? e.message : "Something went wrong"),
    );
  }, [autoPrepare, form, status, applicationId]);

  const preparing = busy || status === "preparing";
  const shownError = error ?? (status === "error" ? statusError : undefined);

  function updateField(si: number, fi: number, patch: Partial<FormField>) {
    if (!local) return;
    const next: ApplicationForm = {
      ...local,
      sections: local.sections.map((s, i) =>
        i !== si ? s : { ...s, fields: s.fields.map((f, j) => (j !== fi ? f : { ...f, ...patch })) },
      ),
    };
    setLocal(next);
    onChange(next);
  }

  const fields = local?.sections.flatMap((s) => s.fields) ?? [];
  const coverField = coverLetterField(local);
  const todo = fields.filter((f) => f.needsUser && !f.value).length;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Application form</h2>
          <p className="mt-1 text-sm text-muted">
            {local
              ? `${local.platform} · ${local.seenOnForm ? "fields read from the real form" : "fields inferred from the posting — check them on the page"}`
              : "BAPTOU opens the application page and prepares every field in the organization's format."}
          </p>
        </div>
        <button
          onClick={prepare}
          disabled={preparing}
          className={local ? "rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50" : "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"}
        >
          {preparing ? "Reading the form… (1–3 min)" : local ? "Prepare again" : "Prepare this application"}
        </button>
      </div>
      {shownError && <p className="mt-2 text-sm text-red-600">{shownError}</p>}
      {preparing && !local && (
        <p className="mt-4 animate-pulse rounded-lg bg-accent/10 p-3 text-sm">
          BAPTOU is opening the application page and reading the form. You can keep reading the offer meanwhile.
        </p>
      )}

      {local && (
        <>
          {local.notes && <p className="mt-3 rounded-lg bg-accent/10 p-3 text-sm">{local.notes}</p>}
          <Checklist fields={fields} docs={docs} letter={letter} />
          {todo > 0 && (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
              {todo} field{todo > 1 ? "s" : ""} only you can answer — marked “Your answer” below.
            </p>
          )}

          <div className="mt-4 grid gap-6">
            {local.sections.map((section, si) => (
              <div key={si}>
                <h3 className="border-b border-border pb-1 text-sm font-semibold uppercase tracking-wide text-muted">
                  {section.title}
                </h3>
                <ul className="mt-3 grid gap-4">
                  {section.fields.map((field, fi) => (
                    <li key={fi}>
                      <FieldView
                        field={field}
                        isCoverLetter={field === coverField}
                        docs={docs}
                        letter={letter}
                        title={title}
                        onChange={(patch) => updateField(si, fi, patch)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <a
            href={local.formUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 font-medium text-white"
          >
            Open the application form ↗
          </a>
        </>
      )}
    </section>
  );
}

const docLabel: Record<string, string> = {
  cv: "CV",
  transcript: "Transcript / grades",
  motivation_letter: "Motivation letter",
  diploma: "Diploma",
  other: "Other document",
};

/** "What you need": files to attach and information only the student can give, ticked when ready. */
function Checklist({
  fields, docs, letter,
}: {
  fields: FormField[];
  docs: (UploadedDocument & { id: string })[];
  letter: string;
}) {
  const files = fields
    .filter((f) => f.kind === "file" && f.suggestedDocument !== "none")
    .map((f) => {
      const ready =
        (f.suggestedDocument === "motivation_letter" && !!letter) || docs.some((d) => d.kind === f.suggestedDocument);
      const hint = ready
        ? docLabel[f.suggestedDocument]
        : f.suggestedDocument === "motivation_letter"
          ? "Write the letter below"
          : `Upload your ${docLabel[f.suggestedDocument].toLowerCase()} on the Profile page`;
      return { label: f.label, required: f.required, ready, hint };
    });
  const info = fields
    .filter((f) => f.needsUser)
    .map((f) => ({ label: f.label, required: f.required, ready: !!f.value, hint: f.value || "To fill in below" }));

  if (!files.length && !info.length) return null;

  return (
    <div className="mt-4 grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
      <ChecklistColumn title="Files to attach" items={files} empty="No files requested." />
      <ChecklistColumn title="Information only you can give" items={info} empty="BAPTOU has prepared everything else." />
    </div>
  );
}

function ChecklistColumn({
  title, items, empty,
}: {
  title: string;
  items: { label: string; required: boolean; ready: boolean; hint: string }[];
  empty: string;
}) {
  return (
    <div>
      <p className="text-sm font-semibold">{title}</p>
      {items.length === 0 && <p className="mt-1 text-sm text-muted">{empty}</p>}
      <ul className="mt-2 grid gap-1.5 text-sm">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className={it.ready ? "text-green-600" : "text-amber-600"}>{it.ready ? "✓" : "○"}</span>
            <span className="min-w-0">
              {it.label}
              {it.required && <span className="text-red-600"> *</span>}
              <span className="block truncate text-xs text-muted">{it.hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FieldView({
  field, isCoverLetter, docs, letter, title, onChange,
}: {
  field: FormField;
  isCoverLetter: boolean;
  docs: (UploadedDocument & { id: string })[];
  letter: string;
  title: string;
  onChange: (patch: Partial<FormField>) => void;
}) {
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm font-medium">
        {field.label}
        {field.required && <span className="text-red-600"> *</span>}
      </p>
      {field.needsUser && (
        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">Your answer</span>
      )}
    </div>
  );
  const note = field.note && <p className="mt-1 text-xs text-muted">{field.note}</p>;

  // The letter is edited in one place only: the Motivation letter section below.
  if (isCoverLetter) {
    return (
      <div>
        {header}
        <div className="mt-2 rounded-lg border border-border bg-background p-3 text-sm">
          {letter ? (
            <p className="line-clamp-4 whitespace-pre-wrap text-muted">{letter}</p>
          ) : (
            <p className="text-muted">No letter yet. Write it in the Motivation letter section below.</p>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <a href="#letter" className="rounded-lg border border-accent px-3 py-1.5 text-sm text-accent">
            Edit the letter ↓
          </a>
          {letter && field.kind === "file" && (
            <button onClick={() => printLetter(letter, title)} className="rounded-lg border border-border px-3 py-1.5 text-sm">
              Save as PDF to attach
            </button>
          )}
          {letter && field.kind !== "file" && <CopyButton text={letter} />}
        </div>
        {field.charLimit > 0 && letter && (
          <p className={`mt-1 text-xs ${letter.length > field.charLimit ? "text-red-600" : "text-muted"}`}>
            {letter.length} / {field.charLimit} characters
          </p>
        )}
        {note}
      </div>
    );
  }

  if (field.kind === "file") {
    const matches = docs.filter((d) => d.kind === field.suggestedDocument);
    const isLetter = field.suggestedDocument === "motivation_letter";
    return (
      <div>
        {header}
        <div className="mt-2 flex flex-wrap gap-2">
          {isLetter && letter && (
            <button onClick={() => printLetter(letter, title)} className="rounded-lg border border-accent px-3 py-1.5 text-sm text-accent">
              Save this application&apos;s letter as PDF
            </button>
          )}
          {matches.map((d) => (
            <button
              key={d.id}
              onClick={async () => window.open(await getDownloadURL(ref(storage, d.storagePath)), "_blank")}
              className="rounded-lg border border-border px-3 py-1.5 text-sm"
            >
              📎 {d.fileName}
            </button>
          ))}
          {!matches.length && !(isLetter && letter) && (
            <p className="text-sm text-muted">
              {field.suggestedDocument === "none" ? "Nothing to attach." : `Upload your ${field.suggestedDocument.replace("_", " ")} on the Profile page.`}
            </p>
          )}
        </div>
        {note}
      </div>
    );
  }

  if (field.kind === "entries") {
    return (
      <div>
        {header}
        <ul className="mt-2 grid gap-2">
          {field.entries.map((e, i) => (
            <EntryCard key={i} entry={e} />
          ))}
        </ul>
        {note}
      </div>
    );
  }

  const long = field.kind === "long_text";
  const over = field.charLimit > 0 && field.value.length > field.charLimit;
  return (
    <div>
      {header}
      {(field.kind === "choice" || field.kind === "yes_no") && field.options.length > 0 && (
        <p className="mt-1 text-xs text-muted">Options: {field.options.join(" · ")}</p>
      )}
      <div className="mt-2 flex gap-2">
        {long ? (
          <textarea
            value={field.value}
            onChange={(e) => onChange({ value: e.target.value })}
            rows={6}
            placeholder={field.needsUser ? "Only you can answer this" : ""}
            className="flex-1 rounded-lg border border-border bg-background p-3 text-sm leading-relaxed"
          />
        ) : (
          <input
            value={field.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder={field.needsUser ? "Only you can answer this" : ""}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        )}
        <CopyButton text={field.value} />
      </div>
      {field.charLimit > 0 && (
        <p className={`mt-1 text-xs ${over ? "text-red-600" : "text-muted"}`}>
          {field.value.length} / {field.charLimit} characters
        </p>
      )}
      {note}
    </div>
  );
}

function EntryCard({ entry }: { entry: FormEntry }) {
  const rows: [string, string][] = [
    ["Title", entry.title],
    ["Organization", entry.organization],
    ["Location", entry.location],
    ["From", entry.startDate],
    ["To", entry.endDate],
    ["Description", entry.description],
  ];
  return (
    <li className="rounded-lg border border-border p-3 text-sm">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-3 py-0.5">
            <p>
              <span className="text-muted">{k}: </span>
              <span className="whitespace-pre-wrap">{v}</span>
            </p>
            <CopyButton text={v} />
          </div>
        ))}
    </li>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      disabled={!text}
      className="h-fit shrink-0 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-40"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Opens the letter in a print-ready window; the browser's "Save as PDF" produces the attachment. */
function printLetter(letter: string, title: string) {
  const w = window.open("", "_blank");
  if (!w) return;
  const escaped = letter.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  w.document.write(`<!doctype html><title>Motivation letter - ${title.replace(/</g, "")}</title>
<style>body{font:11.5pt/1.5 Georgia,serif;max-width:17cm;margin:2.5cm auto;white-space:pre-wrap}@page{margin:0}</style>
<body>${escaped}</body>`);
  w.document.close();
  w.focus();
  w.print();
}
