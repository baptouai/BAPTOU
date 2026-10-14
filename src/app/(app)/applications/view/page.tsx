"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  addDoc, collection, deleteField, doc, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { dismissOffer, statusLabel } from "@/components/ApplicationList";
import { ApplicationFormView, coverLetterField } from "@/components/ApplicationFormView";
import { fitLetter, guessLetterLang, letterBody, type LetterParts, printLetter } from "@/lib/letterLayout";
import { useLetterSender } from "@/lib/letterSender";
import { sendApprovedEmail } from "@/components/Contacts";
import { KnownPeople } from "@/components/MailIndex";
import { DismissForm } from "@/components/DismissForm";
import { FitCheck, verdictLabel } from "@/components/FitCheck";
import { FollowUp } from "@/components/FollowUp";
import { RichText } from "@/components/RichText";
import { looksGeneric } from "@/lib/postingLink";
import type { Application, FormField, LetterVersion } from "@/lib/types";
import { errorText, useI18n } from "@/lib/i18n";

const AUTOSAVE_MS = 800;

type AiInput = { applicationId: string; instructions: string };
const draftLetter = httpsCallable<AiInput, { letter: string; recipient: string; subject: string; language: "en" | "fr" | "other" }>(
  functions,
  "draftLetter",
  { timeout: 540_000 },
);
const draftEmail = httpsCallable<AiInput, NonNullable<Application["emailDraft"]>>(functions, "draftEmail", {
  timeout: 300_000,
});
const checkPostingNow = httpsCallable<{ applicationId: string }, { status: "open" | "closed" | "unknown" | "skipped"; reason?: string }>(
  functions,
  "checkPostingNow",
  { timeout: 120_000 },
);

// The app is exported as static files, so the offer id travels in the query (?id=...) rather than the path.
export default function ApplicationPage() {
  return (
    <Suspense fallback={null}>
      <ApplicationView />
    </Suspense>
  );
}

function ApplicationView() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const [missing, setMissing] = useState(false);
  const { user } = useAuth();
  const [app, setApp] = useState<Application | null>(null);
  // Whether the posting is still online: checked by BAPTOU each time the offer is opened (at most every few hours).
  const [postingCheck, setPostingCheck] = useState<{ id: string; status: "open" | "unknown" | null } | null>(null);
  const postingChecked = useRef("");
  const [letter, setLetter] = useState("");
  const [recipient, setRecipient] = useState(""); // the letter's recipient block (one line each)
  const [subject, setSubject] = useState("");
  const [fit, setFit] = useState<number | null | undefined>(); // text size at which the letter fits on one page
  const sender = useLetterSender();
  const [email, setEmail] = useState<Application["emailDraft"]>();
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">("saved");
  const [versions, setVersions] = useState<(LetterVersion & { id: string })[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Application> | null>(null);
  const loaded = useRef(false);
  const serverLetter = useRef(""); // the letter as last saved, to tell the user's edits from BAPTOU's
  const [sending, setSending] = useState(false);
  const [wantLetter, setWantLetter] = useState(false);
  const [wantEmail, setWantEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const { t, date, dateTime } = useI18n();

  const appRef = user ? doc(db, "users", user.uid, "applications", id) : null;

  // Live updates for BAPTOU's fields; the editors are filled once, then the local state is the
  // source of truth while the user types (and after BAPTOU rewrites, from the call's result).
  useEffect(() => {
    if (!appRef) return;
    return onSnapshot(appRef, (snap) => {
      const data = snap.data() as Application | undefined;
      setMissing(!data);
      if (!data) return;
      setApp(data);
      if (!loaded.current) {
        loaded.current = true;
        setEmail(data.emailDraft);
        // Never an empty recipient box on a letter: the hiring team, the organization and where it is.
        setRecipient(
          data.letterRecipient ||
            (data.letter
              ? [
                  guessLetterLang(data.letter, data.postingLanguage) === "fr" ? "Service recrutement" : "Hiring Manager",
                  data.organization,
                  [data.location, data.country].filter(Boolean).join(", "),
                ]
                  .filter(Boolean)
                  .join("\n")
              : ""),
        );
        setSubject(data.letterSubject ?? "");
        // Forms prepared before the letter was unified kept their cover letter inside the form only.
        const field = coverLetterField(data.applicationForm);
        const fromForm = !data.letter && field && (field.isCoverLetter || field.kind !== "file") ? field.value : undefined;
        setLetter(data.letter || fromForm || "");
        if (fromForm) updateDoc(snap.ref, { letter: fromForm, updatedAt: serverTimestamp() });
      } else if (data.letter) {
        // BAPTOU wrote the letter (e.g. while preparing the form): show it, unless the user has changed theirs.
        setLetter((current) =>
          pending.current?.letter !== undefined || (current && current !== serverLetter.current) ? current : data.letter,
        );
      }
      serverLetter.current = data.letter ?? "";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  const postingDue =
    !!app && ["suggested", "interested", "editing"].includes(app.status) && app.type !== "masters" && !app.postingClosedAt;
  const posting = postingCheck?.id === id ? postingCheck.status : postingDue ? "checking" : null;
  useEffect(() => {
    if (!postingDue || postingChecked.current === id) return;
    postingChecked.current = id;
    checkPostingNow({ applicationId: id })
      .then(({ data }) => setPostingCheck({ id, status: data.status === "unknown" ? "unknown" : data.status === "open" ? "open" : null }))
      .catch(() => setPostingCheck({ id, status: null }));
  }, [postingDue, id]);

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
    setRecipient(data.recipient);
    setSubject(data.subject);
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

  async function dismiss(reason: string) {
    await flushSave();
    await dismissOffer({ applicationId: id, reason });
    router.push(app?.searchId ? `/applications?search=${app.searchId}` : "/applications");
  }

  async function setStatus(status: Application["status"], extra: Partial<Application> = {}) {
    if (!appRef) return;
    // The first time it's marked applied, remember when (the follow-up counts the days from there).
    const applied = status === "applied" && !app?.appliedAt ? { appliedAt: serverTimestamp() as never } : {};
    await updateDoc(appRef, { status, ...applied, ...extra, updatedAt: serverTimestamp() });
    setApp((a) => (a ? { ...a, status } : a));
  }

  async function draftFollowUp(appliedOn: string) {
    setWantEmail(true);
    await writeEmail(
      `A short, polite follow-up on my application${appliedOn ? ` sent on ${appliedOn}` : ""}: ask whether there is any news and restate my interest in one sentence. No pressure, and don't repeat my whole profile.`,
    );
    document.getElementById("email")?.scrollIntoView({ behavior: "smooth" });
  }

  const sent = app?.status === "applied" || app?.status === "rejected";

  const letterParts: LetterParts | null =
    app && sender
      ? {
          lang: app.letterLang === "fr" || app.letterLang === "en" ? app.letterLang : guessLetterLang(letter, app.postingLanguage),
          name: sender.name,
          senderLines: sender.lines,
          recipientLines: (recipient.trim() ? recipient.split("\n") : [app.organization, app.location ?? ""])
            .map((l) => l.trim())
            .filter(Boolean),
          subject: subject.trim(),
          body: letterBody(letter, sender.name),
          signatureUrl: sender.signatureUrl,
        }
      : null;
  const partsKey = letterParts ? JSON.stringify({ ...letterParts, signatureUrl: undefined }) : "";
  useEffect(() => {
    if (!partsKey) return;
    const timer = setTimeout(() => setFit(fitLetter(JSON.parse(partsKey) as LetterParts)), 300);
    return () => clearTimeout(timer);
  }, [partsKey]);

  // Approval and sending are one click: the approved draft is saved, then the server sends exactly
  // what is stored (not what the browser sends), from the user's Gmail.
  async function approveEmail() {
    if (!appRef || !email) return;
    if (!confirm(t("Send this email to {to} from your Gmail now?", { to: email.to || t("(no recipient)") }))) return;
    setEmailError(null);
    setSending(true);
    try {
      await flushSave();
      await setStatus("approved", { emailDraft: email, emailApprovedAt: serverTimestamp() as never });
      await sendApprovedEmail({ kind: "application", id });
    } catch (e) {
      setEmailError(errorText(e, t));
    } finally {
      setSending(false);
    }
  }

  if (missing) {
    return (
      <p className="text-muted">
        {t("This offer was removed.")}{" "}
        <Link href="/applications" className="text-accent">
          {t("Back to applications")}
        </Link>
      </p>
    );
  }
  if (!app) return <p className="text-muted">{t("Loading…")}</p>;

  // The letter appears in one place only: inside the form's letter field once the application is prepared
  // (none if the form doesn't ask for one), in its own section before that.
  const showLetter = !app.applicationForm && (!!letter || wantLetter);
  const showEmail = !!email || wantEmail;
  const letterTitle = `${app.title} - ${app.organization}`;

  const letterEditor = (field?: FormField) => (
    <div>
      {app.approachNote && (
        <div className="mt-2 rounded-lg bg-accent/5 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("The angle BAPTOU took")}</p>
          <RichText text={app.approachNote} className="mt-1" />
        </div>
      )}
      <AiBar
        action={t(letter ? "Rewrite with BAPTOU" : "Write my letter")}
        placeholder={t(letter ? "e.g. Shorter, more formal, mention my Excel skills" : "Optional: anything to emphasize")}
        busyLabel={t("BAPTOU is researching and writing… (1–3 min)")}
        onRun={writeLetter}
      />
      {/* The top of the page: the student's own details come from the Profile page, the recipient from here. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{t("Recipient")}</span>
          <textarea
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              scheduleSave({ letterRecipient: e.target.value });
            }}
            rows={3}
            placeholder={`${t("Hiring team")}\n${app.organization}\n${t("Address")}`}
            className="rounded-lg border border-border bg-background p-2 text-sm"
          />
        </label>
        <label className="grid content-start gap-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{t("Subject line (optional)")}</span>
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              scheduleSave({ letterSubject: e.target.value });
            }}
            placeholder={t("e.g. Application for the summer internship (ref. 1234)")}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          {sender && sender.missing.length > 0 && (
            <span className="text-xs text-muted">
              {t(sender.missing.includes("signature") ? "Add your address, phone and signature on the Profile page: they go on the letter." : "Add your address and phone on the Profile page: they go at the top of the letter.")}{" "}
              <Link href="/profile" className="text-accent">
                {t("Profile")} →
              </Link>
            </span>
          )}
        </label>
      </div>
      <textarea
        value={letter}
        maxLength={field?.charLimit || undefined}
        onChange={(e) => {
          setLetter(e.target.value);
          scheduleSave({ letter: e.target.value });
        }}
        rows={field ? 14 : 18}
        className="mt-3 w-full rounded-lg border border-border bg-background p-3 text-sm leading-relaxed"
      />
      {!!field?.charLimit && !!letter && (
        <p className={`text-xs ${letter.length > field.charLimit ? "text-red-600" : "text-muted"}`}>
          {t("{n} / {max} characters", { n: letter.length, max: field.charLimit })}
        </p>
      )}
      {!!letter && fit !== undefined && (
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
          {fit === 12 ? (
            <span className="text-green-700 dark:text-green-400">✓ {t("Fits on one page")}</span>
          ) : fit ? (
            <span className="text-muted">{t("Fits on one page with slightly smaller text ({n} pt).", { n: fit })}</span>
          ) : (
            <span className="text-red-600">{t("Too long for one page once exported.")}</span>
          )}
          {fit !== 12 && (
            <button
              onClick={() => writeLetter("Shorten the letter so that it fits on one A4 page with its header: about 280 words, keeping the structure and the strongest examples.")}
              className="text-accent underline"
            >
              {t("Shorten to one page")}
            </button>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopyButton text={sender?.name ? `${letterBody(letter, sender.name)}\n\n${sender.name}` : letter} label={t("Copy letter")} copiedLabel={t("Copied")} />
        {letter && letterParts && (
          <button onClick={() => printLetter(letterParts, letterTitle)} className="rounded-lg border border-border px-3 py-1.5 text-sm">
            {t(field?.kind === "file" ? "Save as PDF to attach" : "Save as PDF")}
          </button>
        )}
        <button onClick={saveVersion} className="rounded-lg border border-border px-3 py-1.5 text-sm">
          {t("Save as version")}
        </button>
        <span className="text-xs text-muted">
          {t(saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved changes")}
        </span>
      </div>
      {versions.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted">{t("Version history ({n})", { n: versions.length })}</summary>
          <ul className="mt-2 grid gap-2">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-2">
                <span className="text-muted">
                  {t(v.author === "baptou" ? "BAPTOU draft" : "Your version")} ·{" "}
                  {v.createdAt ? dateTime(v.createdAt.toDate()) : t("just now")}
                </span>
                <button onClick={() => restore(v)} className="text-accent">
                  {t("Restore")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  return (
    <div className="grid gap-6">
      <div>
        <Link href={app.searchId ? `/applications?search=${app.searchId}` : "/applications"} className="text-sm text-muted">
          {t("← Back")}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{app.title}</h1>
            <p className="text-muted">{app.organization}</p>
            <FactTags app={app} />
          </div>
          <div className="flex gap-2">
            {app.fitVerdict && (
              <span className={`rounded-full px-3 py-1 text-sm font-medium ${verdictLabel[app.fitVerdict].className}`}>
                {t(verdictLabel[app.fitVerdict].text)}
              </span>
            )}
            <span className="rounded-full border border-border px-3 py-1 text-sm">{t(statusLabel[app.status])}</span>
          </div>
        </div>
      </div>

      {app.chance != null && <Chance app={app} />}

      {app.postingClosedAt && !sent && (
        <section className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-800 dark:text-red-300">
          <p className="font-medium">{t("This posting seems to be closed.")}</p>
          <p className="mt-0.5">
            {t("Checked {date}: {reason}. You may want to dismiss it, or check the company's careers page for a newer version.", {
              date: date(app.postingClosedAt.toDate(), "short"),
              reason: t(app.postingClosedReason || "the page is no longer available"),
            })}
          </p>
        </section>
      )}

      {!app.postingClosedAt && posting === "checking" && (
        <p className="text-xs text-muted">{t("Checking that the posting is still online…")}</p>
      )}
      {!app.postingClosedAt && posting === "unknown" && !looksGeneric(app.applyUrl) && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
          <p className="font-medium">{t("BAPTOU couldn't confirm that this posting is still open.")}</p>
          <p className="mt-0.5">{t("Open the offer to check it before you spend time on it.")}</p>
        </section>
      )}

      {!app.postingClosedAt && looksGeneric(app.applyUrl) && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
          <p className="font-medium">{t("This link goes to a careers page or a list of offers, not to the posting itself.")}</p>
          <p className="mt-0.5">
            {t("Look for the exact offer on that page. If you find it, add it with “+ Add an offer you found” and dismiss this one.")}
          </p>
        </section>
      )}

      {sent && (
        <FollowUp
          applicationId={id}
          app={app}
          onDraftFollowUp={draftFollowUp}
          onSetStatus={(s) => setStatus(s)}
          // Marked as applied by mistake: back to Interested (the application work is kept), or delete it.
          onUndoApplied={() => setStatus("interested", { appliedAt: deleteField() as never })}
          onDelete={() => dismiss("")}
        />
      )}

      {(app.matchReason || app.research) && (
        <div className="grid gap-4 md:grid-cols-2">
          {app.matchReason && (
            <section className="rounded-xl border border-card-edge bg-card p-5 text-sm">
              <h2 className="font-medium">{t("Why it fits you")}</h2>
              <RichText text={app.matchReason} className="mt-2" />
            </section>
          )}
          {app.research && (
            <section className="rounded-xl border border-card-edge bg-card p-5 text-sm">
              <h2 className="font-medium">{t("About {name}", { name: app.organization })}</h2>
              <RichText text={app.research} className="mt-2 text-muted" />
            </section>
          )}
        </div>
      )}

      {app.postingText && (
        <details className="rounded-xl border border-card-edge bg-card p-5 text-sm">
          <summary className="cursor-pointer font-medium">{t("The offer, as you pasted it")}</summary>
          <p className="mt-3 whitespace-pre-line text-muted">{app.postingText}</p>
        </details>
      )}

      {app.status === "suggested" && (
        <section className="flex flex-wrap items-start gap-3 rounded-xl border border-card-edge bg-card p-5">
          <p className="w-full text-sm text-muted">{t("Is this offer for you?")}</p>
          <button onClick={() => setStatus("interested")} className="rounded-lg bg-accent px-4 py-2 font-medium text-white">
            {t("I'm interested")}
          </button>
          <DismissForm onDismiss={dismiss} />
        </section>
      )}

      {/* Preparing the application only starts once the user says they're interested. */}
      {app.status !== "suggested" && (
        <>
        <ApplicationFormView
          applicationId={id}
          applyUrl={app.applyUrl}
          form={app.applicationForm}
          status={app.applicationFormStatus}
          statusError={app.applicationFormError}
          autoPrepare={false} // each preparation costs Claude credit, so it only runs on click
          letter={letter}
          onChange={(applicationForm) => scheduleSave({ applicationForm })}
          onLetterFitted={setLetter}
          renderLetter={letterEditor}
        />

        {/* Before the form is prepared: the letter box when wanted. The email box only on request. */}
        {showLetter && (
          <section id="letter" className="scroll-mt-4 rounded-xl border border-card-edge bg-card p-5">
            <h2 className="font-medium">{t("Motivation letter")}</h2>
            {letterEditor()}
          </section>
          )}

          {showEmail && (
          <section id="email" className="scroll-mt-4 rounded-xl border border-card-edge bg-card p-5">
            <h2 className="font-medium">{t("Email draft")}</h2>
            <p className="mt-1 text-sm text-muted">{t("Nothing is sent until you click “Approve & send”.")}</p>
            <AiBar
              action={t(email ? "Rewrite email" : "Draft an email")}
              placeholder={t(email ? "e.g. Warmer tone, in French" : "Optional: who it's for, what to say")}
              busyLabel={t("BAPTOU is writing the email…")}
              onRun={writeEmail}
            />
            {email && (
              <>
              <div className="mt-3 grid gap-2">
                <input
                  value={email.to}
                  onChange={(e) => { const next = { ...email, to: e.target.value }; setEmail(next); scheduleSave({ emailDraft: next }); }}
                  placeholder={t("To")}
                  className="rounded-lg border border-border bg-background px-3 py-2"
                />
                <input
                  value={email.subject}
                  onChange={(e) => { const next = { ...email, subject: e.target.value }; setEmail(next); scheduleSave({ emailDraft: next }); }}
                  placeholder={t("Subject")}
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
                disabled={sending || !!app.emailSentAt}
                className="mt-3 rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
              >
                {t(app.emailSentAt ? "Sent" : sending ? "Sending…" : "Approve & send")}
              </button>
              {emailError && <p className="mt-2 text-sm text-red-600">{emailError}</p>}
              </>
            )}
          </section>
          )}

          {((!showLetter && !app.applicationForm) || !showEmail) && (
            <div className="flex flex-wrap gap-4 text-sm">
              {!showLetter && !app.applicationForm && (
                <button onClick={() => setWantLetter(true)} className="text-muted underline">
                  {t("Write a motivation letter")}
                </button>
              )}
              {!showEmail && (
                <button onClick={() => setWantEmail(true)} className="text-muted underline">
                  {t("Draft an email to the recruiter")}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <KnownPeople applicationId={id} organization={app.organization} applyUrl={app.applyUrl} />

      <FitCheck applicationId={id} />

      <section className="rounded-xl border border-card-edge bg-card p-5">
        {!app.applicationForm && !!app.packFields?.length && (
          <>
            <h2 className="font-medium">{t("Quick answers")}</h2>
            <p className="mt-1 text-sm text-muted">{t("Prepare the application above to get them in the form's exact format.")}</p>
          </>
        )}
        <ul className="mt-3 grid gap-3 empty:hidden">
          {(app.applicationForm ? [] : app.packFields ?? []).map((f) => (
            <li key={f.label} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">{f.label}</p>
                <CopyButton text={f.value} label={t("Copy")} copiedLabel={t("Copied")} />
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
              {t("Open posting")} ↗
            </a>
          )}
          {app.status !== "applied" && (
            <button onClick={() => setStatus("applied")} className="rounded-lg border border-border px-4 py-2">
              {t("Mark as applied")}
            </button>
          )}
          {app.status !== "suggested" && app.status !== "applied" && !app.emailSentAt && <DismissForm onDismiss={dismiss} />}
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
  const { t } = useI18n();

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onRun(instructions);
      setInstructions("");
    } catch (err) {
      setError(errorText(err, t));
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

/** At the top of the offer: BAPTOU's estimate of the student's chance (admission, or an interview). */
function Chance({ app }: { app: Application }) {
  const { t } = useI18n();
  const n = app.chance ?? 0;
  const tone =
    n >= 60
      ? "border-green-500/40 bg-green-500/10 text-green-800 dark:text-green-300"
      : n >= 30
        ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
        : "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-300";
  return (
    <section className={`flex items-start gap-4 rounded-xl border p-4 ${tone}`}>
      <p className="text-3xl font-semibold tabular-nums leading-none">{n}%</p>
      <div className="min-w-0 text-sm">
        <p className="font-medium">
          {t(app.type === "masters" ? "Estimated chance of admission" : "Estimated chance of getting an interview")}
        </p>
        {app.chanceReason && <p className="mt-0.5">{app.chanceReason}</p>}
        <p className="mt-1 text-xs opacity-80">{t("BAPTOU's estimate from your profile and how selective this is: a guide, not a promise.")}</p>
      </div>
    </section>
  );
}

/** Location, start, duration and deadline as small tags under the title. */
function FactTags({ app }: { app: Application }) {
  const [now] = useState(() => Date.now());
  const { t, day } = useI18n();
  const deadline = app.deadline?.toDate();
  const soon = deadline && deadline.getTime() - now < 7 * 86_400_000;
  const opens = app.applicationsOpenAt?.toDate();
  const notOpenYet = opens && opens.getTime() > now;
  const facts = [
    [app.location, app.country].filter(Boolean).join(", "),
    app.startDate && t("Starts {date}", { date: app.startDate }),
    app.duration,
    app.contractType,
    app.rhythm,
    app.salary,
    app.school && t("School: {name}", { name: app.school }),
    app.recommendationLetters != null &&
      t(
        app.recommendationLetters === 0
          ? "No recommendation letters needed"
          : app.recommendationLetters === 1
            ? "1 recommendation letter needed"
            : "{n} recommendation letters needed",
        { n: app.recommendationLetters },
      ),
  ].filter(Boolean) as string[];
  if (!facts.length && !deadline && !opens) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
      {facts.map((f) => (
        <span key={f} className="rounded-full border border-border px-2 py-0.5 text-muted">
          {f}
        </span>
      ))}
      {opens && (
        <span
          className={`rounded-full border px-2 py-0.5 ${
            notOpenYet ? "border-accent/40 bg-accent/10 text-accent" : "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
          }`}
        >
          {t(notOpenYet ? "Applications open {date}" : "Applications open since {date}", { date: day(opens) })}
        </span>
      )}
      {deadline && (
        <span
          className={`rounded-full border px-2 py-0.5 ${
            soon ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" : "border-border text-muted"
          }`}
        >
          {t(app.type === "masters" ? "Applications close {date}" : "Deadline {date}", { date: day(deadline) })}
        </span>
      )}
    </div>
  );
}

function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
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
      {copied ? copiedLabel : label}
    </button>
  );
}
