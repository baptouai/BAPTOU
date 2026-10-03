"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  addDoc, collection, deleteField, doc, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { statusLabel } from "@/components/ApplicationList";
import { ApplicationFormView, coverLetterField } from "@/components/ApplicationFormView";
import { DismissForm } from "@/components/DismissForm";
import { FitCheck, verdictLabel } from "@/components/FitCheck";
import type { Application, LetterVersion } from "@/lib/types";

const AUTOSAVE_MS = 800;

type AiInput = { applicationId: string; instructions: string };
const draftLetter = httpsCallable<AiInput, { letter: string }>(functions, "draftLetter", { timeout: 540_000 });
const draftEmail = httpsCallable<AiInput, NonNullable<Application["emailDraft"]>>(functions, "draftEmail", {
  timeout: 300_000,
});

export default function ApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [app, setApp] = useState<Application | null>(null);
  const [letter, setLetter] = useState("");
  const [email, setEmail] = useState<Application["emailDraft"]>();
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">("saved");
  const [versions, setVersions] = useState<(LetterVersion & { id: string })[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Application> | null>(null);
  const loaded = useRef(false);

  const appRef = user ? doc(db, "users", user.uid, "applications", id) : null;

  // Live updates for BAPTOU's fields; the editors are filled once, then the local state is the
  // source of truth while the user types (and after BAPTOU rewrites, from the call's result).
  useEffect(() => {
    if (!appRef) return;
    return onSnapshot(appRef, (snap) => {
      const data = snap.data() as Application | undefined;
      if (!data) return;
      setApp(data);
      if (!loaded.current) {
        loaded.current = true;
        setEmail(data.emailDraft);
        // Forms prepared before the letter was unified kept their cover letter inside the form only.
        const fromForm = !data.letter ? coverLetterField(data.applicationForm)?.value : undefined;
        setLetter(data.letter || fromForm || "");
        if (fromForm) updateDoc(snap.ref, { letter: fromForm, updatedAt: serverTimestamp() });
      } else if (data.letter) {
        // BAPTOU filled an empty letter (e.g. while preparing the form): show it unless the user is typing.
        setLetter((current) => (current || pending.current?.letter !== undefined ? current : data.letter));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  useEffect(() => {
    if (!appRef) return;
    const q = query(collection(appRef, "letterVersions"), orderBy("createdAt", "desc"), limit(20));
    return onSnapshot(q, (snap) =>
      setVersions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as LetterVersion) }))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  function scheduleSave(patch: Partial<Application>) {
    if (!appRef) return;
    setSaveState("unsaved");
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushSave, AUTOSAVE_MS);
  }

  async function flushSave() {
    if (!appRef || !pending.current) return;
    if (timer.current) clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = null;
    setSaveState("saving");
    await updateDoc(appRef, {
      ...patch,
      status: app?.status === "suggested" ? "editing" : app?.status,
      updatedAt: serverTimestamp(),
    });
    setSaveState("saved");
  }

  // Saves the user's latest edits first, so BAPTOU rewrites what is actually on screen.
  async function writeLetter(instructions: string) {
    await flushSave();
    const { data } = await draftLetter({ applicationId: id, instructions });
    setLetter(data.letter);
  }

  async function writeEmail(instructions: string) {
    await flushSave();
    const { data } = await draftEmail({ applicationId: id, instructions });
    setEmail(data);
  }

  async function saveVersion() {
    if (!appRef) return;
    await addDoc(collection(appRef, "letterVersions"), {
      text: letter,
      author: "user",
      createdAt: serverTimestamp(),
    });
  }

  function restore(v: LetterVersion) {
    setLetter(v.text);
    scheduleSave({ letter: v.text });
  }

  async function setStatus(status: Application["status"], extra: Partial<Application> = {}) {
    if (!appRef) return;
    await updateDoc(appRef, { status, ...extra, updatedAt: serverTimestamp() });
    setApp((a) => (a ? { ...a, status } : a));
  }

  async function approveEmail() {
    if (!appRef || !email) return;
    await saveVersion();
    // The Cloud Function `sendApprovedEmail` (step 5) sends exactly this approved draft.
    await setStatus("approved", { emailDraft: email, emailApprovedAt: serverTimestamp() as never });
  }

  if (!app) return <p className="text-muted">Loading…</p>;

  return (
    <div className="grid gap-6">
      <div>
        <Link href={app.type === "masters" ? "/universities" : "/applications"} className="text-sm text-muted">
          ← Back
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{app.title}</h1>
            <p className="text-muted">{app.organization}{app.country ? ` · ${app.country}` : ""}</p>
          </div>
          <div className="flex gap-2">
            {app.fitVerdict && (
              <span className={`rounded-full px-3 py-1 text-sm font-medium ${verdictLabel[app.fitVerdict].className}`}>
                {verdictLabel[app.fitVerdict].text}
              </span>
            )}
            <span className="rounded-full border border-border px-3 py-1 text-sm">{statusLabel[app.status]}</span>
          </div>
        </div>
      </div>

      {app.status === "dismissed" && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5 text-sm">
          <p>
            <span className="font-medium">You dismissed this offer.</span>{" "}
            <span className="text-muted">{app.dismissReason}</span>
          </p>
          <button
            onClick={() => setStatus("suggested", { dismissReason: deleteField() as never })}
            className="rounded-lg border border-border px-3 py-1.5"
          >
            Restore
          </button>
        </section>
      )}

      <ApplicationFormView
        applicationId={id}
        form={app.applicationForm}
        status={app.applicationFormStatus}
        statusError={app.applicationFormError}
        autoPrepare={false} // each preparation costs Claude credit, so it only runs on click
        letter={letter}
        title={`${app.title} - ${app.organization}`}
        onChange={(applicationForm) => scheduleSave({ applicationForm })}
      />

      <section id="letter" className="scroll-mt-4 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Motivation letter</h2>
          <span className="text-xs text-muted">
            {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved changes"}
          </span>
        </div>
        <AiBar
          action={letter ? "Rewrite with BAPTOU" : "Write my letter"}
          placeholder={letter ? "e.g. Shorter, more formal, mention my Excel skills" : "Optional: anything to emphasize"}
          busyLabel="BAPTOU is researching and writing… (1–3 min)"
          onRun={writeLetter}
        />
        <textarea
          value={letter}
          onChange={(e) => {
            setLetter(e.target.value);
            scheduleSave({ letter: e.target.value });
          }}
          rows={18}
          className="mt-3 w-full rounded-lg border border-border bg-background p-3 leading-relaxed"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={saveVersion} className="rounded-lg border border-border px-3 py-1.5 text-sm">
            Save as version
          </button>
          <CopyButton text={letter} label="Copy letter" />
        </div>
        {versions.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted">Version history ({versions.length})</summary>
            <ul className="mt-2 grid gap-2">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-2">
                  <span className="text-muted">
                    {v.author === "baptou" ? "BAPTOU draft" : "Your version"} ·{" "}
                    {v.createdAt?.toDate().toLocaleString() ?? "just now"}
                  </span>
                  <button onClick={() => restore(v)} className="text-accent">Restore</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-medium">Email draft</h2>
        <p className="mt-1 text-sm text-muted">Nothing is sent until you click “Approve &amp; send”.</p>
        <AiBar
          action={email ? "Rewrite email" : "Draft an email"}
          placeholder={email ? "e.g. Warmer tone, in French" : "Optional: who it's for, what to say"}
          busyLabel="BAPTOU is writing the email…"
          onRun={writeEmail}
        />
        {email && (
          <>
          <div className="mt-3 grid gap-2">
            <input
              value={email.to}
              onChange={(e) => { const next = { ...email, to: e.target.value }; setEmail(next); scheduleSave({ emailDraft: next }); }}
              placeholder="To"
              className="rounded-lg border border-border bg-background px-3 py-2"
            />
            <input
              value={email.subject}
              onChange={(e) => { const next = { ...email, subject: e.target.value }; setEmail(next); scheduleSave({ emailDraft: next }); }}
              placeholder="Subject"
              className="rounded-lg border border-border bg-background px-3 py-2"
            />
            <textarea
              value={email.body}
              onChange={(e) => { const next = { ...email, body: e.target.value }; setEmail(next); scheduleSave({ emailDraft: next }); }}
              rows={10}
              className="rounded-lg border border-border bg-background p-3"
            />
          </div>
          <button
            onClick={approveEmail}
            disabled={app.status === "approved" || !!app.emailSentAt}
            className="mt-3 rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {app.emailSentAt ? "Sent" : app.status === "approved" ? "Approved" : "Approve & send"}
          </button>
          </>
        )}
      </section>

      {(app.matchReason || app.research || app.approachNote) && (
        <section className="grid gap-3 rounded-xl border border-border bg-card p-5 text-sm">
          {app.matchReason && <Info title="Why BAPTOU suggests it" text={app.matchReason} />}
          {app.research && <Info title="Research" text={app.research} />}
          {app.approachNote && <Info title="Approach taken in the letter" text={app.approachNote} />}
        </section>
      )}

      <FitCheck applicationId={id} />

      <section className="rounded-xl border border-border bg-card p-5">
        {!app.applicationForm && !!app.packFields?.length && (
          <>
            <h2 className="font-medium">Quick answers</h2>
            <p className="mt-1 text-sm text-muted">Prepare the application above to get them in the form&apos;s exact format.</p>
          </>
        )}
        <ul className="mt-3 grid gap-3 empty:hidden">
          {(app.applicationForm ? [] : app.packFields ?? []).map((f) => (
            <li key={f.label} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">{f.label}</p>
                <CopyButton text={f.value} label="Copy" />
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{f.value}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          {app.applyUrl && (
            <a
              href={app.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-accent px-4 py-2 font-medium text-white"
            >
              Open posting ↗
            </a>
          )}
          {app.status !== "applied" && (
            <button onClick={() => setStatus("applied")} className="rounded-lg border border-border px-4 py-2">
              Mark as applied
            </button>
          )}
          {(app.status === "suggested" || app.status === "editing") && (
            <DismissForm onDismiss={(reason) => setStatus("dismissed", { dismissReason: reason })} />
          )}
        </div>
      </section>
    </div>
  );
}

function AiBar({
  action, placeholder, busyLabel, onRun,
}: { action: string; placeholder: string; busyLabel: string; onRun: (instructions: string) => Promise<void> }) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onRun(instructions);
      setInstructions("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={run} className="mt-3 flex flex-col gap-2 sm:flex-row">
      <input
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? busyLabel : action}
      </button>
      {error && <p className="text-sm text-red-600 sm:basis-full">{error}</p>}
    </form>
  );
}

function Info({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-muted">{text}</p>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-lg border border-border px-3 py-1.5 text-sm"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
