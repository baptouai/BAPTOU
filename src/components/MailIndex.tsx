"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, limit, onSnapshot, orderBy, query, where, type Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { offerTokens } from "@/lib/orgTokens";
import { ContactsPanel } from "@/components/Contacts";

// users/{uid}/mailIndex/{id}, built from email headers by the server (no AI). See functions/src/mailIndex.ts.
type Person = {
  email: string;
  name: string;
  domain: string;
  sent: number;
  received: number;
  lastAt: number;
  lastSubject: string;
};
type IndexStatus = { status?: "queued" | "running" | "ready" | "error"; people?: number; updatedAt?: Timestamp; backfillDone?: boolean };

const draftFromIndex = httpsCallable<{ indexId: string; applicationId?: string }, { contactId: string }>(
  functions,
  "draftFromIndex",
  { timeout: 300_000 },
);
const refreshMailIndex = httpsCallable<void, { queued: boolean }>(functions, "refreshMailIndex");

function useIndexStatus() {
  const { user } = useAuth();
  const [status, setStatus] = useState<IndexStatus | null | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => {
      setStatus((snap.get("mailIndex") as IndexStatus) ?? null);
      setConnected(!!snap.get("gmail.email") && !snap.get("gmail.needsReconnect"));
    });
  }, [user]);
  return { status, connected };
}

/**
 * On an offer: people from the mailbox whose email domain matches the organization. Found by a plain
 * database query on the index, so it's automatic and free. Drafting an email is the only AI step.
 */
export function KnownPeople({ applicationId, organization, applyUrl }: { applicationId: string; organization: string; applyUrl?: string }) {
  const { user } = useAuth();
  const { status, connected } = useIndexStatus();
  const [people, setPeople] = useState<(Person & { id: string })[]>([]);
  const tokens = useMemo(() => offerTokens(organization, applyUrl), [organization, applyUrl]);

  useEffect(() => {
    if (!user || !tokens.length) return;
    const q = query(collection(db, "users", user.uid, "mailIndex"), where("tokens", "array-contains-any", tokens), limit(30));
    return onSnapshot(q, (snap) =>
      setPeople(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Person) }))
          .sort((a, b) => b.sent * 2 + b.received - (a.sent * 2 + a.received) || b.lastAt - a.lastAt),
      ),
    );
  }, [user, tokens]);

  if (!connected) return null; // nothing to match against
  if (status?.status !== "ready" && !people.length) {
    return (
      <section className="rounded-xl border border-border bg-card p-5 text-sm text-muted">
        BAPTOU is indexing your mailbox (no credit used). People you know at {organization} will show up here.
      </section>
    );
  }
  if (!people.length) return null; // nobody known there: stay quiet

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-medium">People you know at {organization}</h2>
      <p className="mt-1 text-sm text-muted">Found in your mailbox automatically, without using credits.</p>
      <ul className="mt-3 grid gap-2">
        {people.map((p) => (
          <PersonRow key={p.id} person={p} applicationId={applicationId} />
        ))}
      </ul>
      <div className="mt-4">
        <ContactsPanel applicationId={applicationId} listOnly />
      </div>
    </section>
  );
}

function PersonRow({ person: p, applicationId }: { person: Person & { id: string }; applicationId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      await draftFromIndex({ indexId: p.id, ...(applicationId ? { applicationId } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
      <div className="min-w-0">
        <p className="font-medium">
          {p.name || p.email} <span className="font-normal text-muted">&lt;{p.email}&gt;</span>
        </p>
        <p className="truncate text-muted">
          {p.sent} sent · {p.received} received · last {new Date(p.lastAt).toLocaleDateString()}
          {p.lastSubject && ` · “${p.lastSubject}”`}
        </p>
      </div>
      <button onClick={draft} disabled={busy} className="rounded-lg border border-accent px-3 py-1.5 text-accent disabled:opacity-50">
        {busy ? "Writing…" : "Draft an email"}
      </button>
      {error && <p className="w-full text-red-600">{error}</p>}
    </li>
  );
}

// Words suggesting someone can help with an internship (recruiters, schools, careers services).
const HELPFUL = /recrut|recruit|talent|rh\b|hr\b|human resources|ressources humaines|stage|intern|alternan|carri|career|campus|alumni|professeur|professor|prof\b|universit|ecole|school|mentor|manager|entretien|interview|candidature|application/i;

/** Contacts page: everyone in the mail index, searchable, likely helpers first. Free; drafting uses AI. */
export function MailIndexPanel() {
  const { user } = useAuth();
  const { status, connected } = useIndexStatus();
  const [people, setPeople] = useState<(Person & { id: string })[]>([]);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now()); // for recency scoring; stable during the session

  useEffect(() => {
    if (!user || !connected) return;
    const q = query(collection(db, "users", user.uid, "mailIndex"), orderBy("lastAt", "desc"), limit(1000));
    return onSnapshot(q, (snap) => setPeople(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Person) }))));
  }, [user, connected]);

  const ranked = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const yearMs = 365 * 24 * 3600 * 1000;
    return people
      .filter((p) => !f || `${p.name} ${p.email} ${p.lastSubject}`.toLowerCase().includes(f))
      .map((p) => ({
        p,
        score:
          (HELPFUL.test(`${p.name} ${p.email} ${p.lastSubject}`) ? 10 : 0) +
          Math.min(p.sent, 10) * 2 +
          Math.min(p.received, 10) +
          Math.max(0, 5 - (now - p.lastAt) / yearMs),
      }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }, [people, filter, now]);

  async function refresh() {
    setError(null);
    try {
      await refreshMailIndex();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  if (!connected) {
    return (
      <section className="rounded-xl border border-border bg-card p-5 text-sm">
        <Link href="/profile" className="text-accent">Connect Gmail</Link> to see the people in your mailbox.
      </section>
    );
  }

  const working = status?.status === "queued" || status?.status === "running";
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">People in your mailbox</h2>
          <p className="mt-1 text-sm text-muted">
            {working
              ? "Indexing your mailbox… (no credit used)"
              : status?.status === "error"
                ? "The last update failed. Try again."
                : `${status?.people ?? people.length} people${status?.updatedAt ? ` · updated ${status.updatedAt.toDate().toLocaleString()}` : ""}${
                    status?.backfillDone === false ? " · older emails are still being added" : ""
                  }. Built from email headers only, without credits.`}
          </p>
        </div>
        <button onClick={refresh} disabled={working} className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">
          {working ? "Updating…" : "Update now"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <input
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setShown(20);
        }}
        placeholder="Search by name, email, company or subject"
        className="mt-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <ul className="mt-3 grid gap-2">
        {ranked.slice(0, shown).map((p) => (
          <PersonRow key={p.id} person={p} />
        ))}
      </ul>
      {ranked.length > shown && (
        <button onClick={() => setShown((n) => n + 20)} className="mt-3 text-sm text-muted">
          Show more ({ranked.length - shown} left)
        </button>
      )}
    </section>
  );
}
