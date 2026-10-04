"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { Contact, GmailConnection } from "@/lib/types";

const findContacts = httpsCallable<{ applicationId?: string }, { found: number; summary: string }>(functions, "findContacts", {
  timeout: 540_000,
});
const draftContactEmail = httpsCallable<{ contactId: string; instructions: string }, Contact["draft"]>(
  functions,
  "draftContactEmail",
  { timeout: 300_000 },
);
export const sendApprovedEmail = httpsCallable<{ kind: "contact" | "application"; id: string }, { ok: boolean }>(
  functions,
  "sendApprovedEmail",
);

const relationshipLabel: Record<Contact["relationship"], string> = {
  recruiter: "Recruiter",
  manager: "Former manager",
  colleague: "Colleague",
  professor: "Professor",
  alumni: "Alumni",
  classmate: "Classmate",
  friend: "Friend",
  other: "Contact",
};

/**
 * People from the mailbox to contact, with draft emails. With `applicationId`, only people found for
 * that offer, and the search focuses on its organization.
 */
export function ContactsPanel({ applicationId, organization }: { applicationId?: string; organization?: string }) {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<(Contact & { id: string })[]>([]);
  const [gmail, setGmail] = useState<GmailConnection | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!user) return;
    const base = collection(db, "users", user.uid, "contacts");
    const q = applicationId
      ? query(base, where("applicationIds", "array-contains", applicationId))
      : query(base, orderBy("updatedAt", "desc"));
    const unsubContacts = onSnapshot(q, (snap) =>
      setContacts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Contact) }))),
    );
    const unsubUser = onSnapshot(doc(db, "users", user.uid), (snap) => setGmail((snap.get("gmail") as GmailConnection) ?? null));
    return () => {
      unsubContacts();
      unsubUser();
    };
  }, [user, applicationId]);

  async function search() {
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await findContacts(applicationId ? { applicationId } : {});
      setMessage(data.found ? data.summary : `No new contacts found. ${data.summary}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const connected = !!gmail?.email && !gmail.needsReconnect;
  const visible = contacts.filter((c) => showAll || c.status !== "dismissed");
  const dismissed = contacts.length - contacts.filter((c) => c.status !== "dismissed").length;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="font-medium">{applicationId ? `People you know${organization ? ` at or near ${organization}` : ""}` : "People to contact"}</h2>
          <p className="mt-1 text-sm text-muted">
            BAPTOU searches your Gmail for people who could help and drafts an email that follows on from your past
            conversations. Nothing is sent until you approve it.
          </p>
        </div>
        {connected ? (
          <button onClick={search} disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Searching your mailbox… (1–3 min)" : contacts.length ? "Search again" : "Search my mailbox"}
          </button>
        ) : (
          gmail !== undefined && (
            <Link href="/profile" className="rounded-lg border border-accent px-4 py-2 text-sm text-accent">
              Connect Gmail first
            </Link>
          )
        )}
      </div>
      {message && <p className="mt-3 rounded-lg bg-accent/10 p-3 text-sm">{message}</p>}

      <ul className="mt-4 grid gap-4">
        {visible.map((c) => (
          <li key={c.id}>
            <ContactCard contact={c} />
          </li>
        ))}
      </ul>
      {dismissed > 0 && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-3 text-sm text-muted">
          {showAll ? "Hide dismissed" : `Show dismissed (${dismissed})`}
        </button>
      )}
    </section>
  );
}

function ContactCard({ contact }: { contact: Contact & { id: string } }) {
  const { user } = useAuth();
  const [draft, setDraft] = useState(contact.draft);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState<null | "rewrite" | "send">(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = user ? doc(db, "users", user.uid, "contacts", contact.id) : null;
  const sent = contact.status === "sent";

  function edit(patch: Partial<Contact["draft"]>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!ref) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => updateDoc(ref, { draft: next, draftEditedByUser: true, updatedAt: serverTimestamp() }),
      800,
    );
  }

  async function flush() {
    if (timer.current && ref) {
      clearTimeout(timer.current);
      await updateDoc(ref, { draft, draftEditedByUser: true, updatedAt: serverTimestamp() });
    }
  }

  async function rewrite(e: React.FormEvent) {
    e.preventDefault();
    setBusy("rewrite");
    setError(null);
    try {
      await flush();
      const { data } = await draftContactEmail({ contactId: contact.id, instructions });
      setDraft(data);
      setInstructions("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!confirm(`Send this email to ${draft.to} from your Gmail now?`)) return;
    setBusy("send");
    setError(null);
    try {
      await flush();
      await sendApprovedEmail({ kind: "contact", id: contact.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`rounded-lg border border-border p-4 ${contact.status === "dismissed" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {contact.name} <span className="font-normal text-muted">&lt;{contact.email}&gt;</span>
          </p>
          <p className="text-sm text-muted">
            {[contact.role, contact.organization].filter(Boolean).join(" · ")}
            {contact.lastContactDate && ` · last contact ${contact.lastContactDate}`}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs">
          {sent ? "Sent" : relationshipLabel[contact.relationship]}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-sm">
        <p><span className="font-medium">Your history: </span><span className="text-muted">{contact.history}</span></p>
        <p><span className="font-medium">Why contact them: </span><span className="text-muted">{contact.whyContact}</span></p>
      </div>

      <div className="mt-4 grid gap-2">
        <p className="text-xs text-muted">
          {contact.replyInThread ? "Sent as a reply in your previous conversation." : "Sent as a new email."}
        </p>
        <input
          value={draft.to}
          onChange={(e) => edit({ to: e.target.value })}
          disabled={sent}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <input
          value={draft.subject}
          onChange={(e) => edit({ subject: e.target.value })}
          disabled={sent}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <textarea
          value={draft.body}
          onChange={(e) => edit({ body: e.target.value })}
          disabled={sent}
          rows={8}
          className="rounded-lg border border-border bg-background p-3 text-sm leading-relaxed"
        />
      </div>

      {!sent && (
        <>
          <form onSubmit={rewrite} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={!!busy}
              placeholder="e.g. More formal, mention the VCARB offer, in French"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <button disabled={!!busy} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">
              {busy === "rewrite" ? "Rewriting…" : "Rewrite"}
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={send} disabled={!!busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy === "send" ? "Sending…" : "Approve & send"}
            </button>
            {contact.status !== "dismissed" ? (
              <button
                onClick={() => ref && updateDoc(ref, { status: "dismissed", updatedAt: serverTimestamp() })}
                className="rounded-lg px-4 py-2 text-sm text-muted"
              >
                Not this person
              </button>
            ) : (
              <button
                onClick={() => ref && updateDoc(ref, { status: "suggested", updatedAt: serverTimestamp() })}
                className="rounded-lg px-4 py-2 text-sm text-muted"
              >
                Restore
              </button>
            )}
          </div>
        </>
      )}
      {sent && <p className="mt-3 text-sm text-green-700 dark:text-green-400">Sent {contact.sentAt?.toDate().toLocaleString()}.</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
