"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  arrayRemove, arrayUnion, collection, doc, limit, onSnapshot, orderBy, query, setDoc, where, type Timestamp,
} from "firebase/firestore";
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

/** Favourite people, by email, on users/{uid}.favouriteContacts. */
function useFavourites() {
  const { user } = useAuth();
  const [favourites, setFavourites] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) =>
      setFavourites(new Set((snap.get("favouriteContacts") as string[]) ?? [])),
    );
  }, [user]);
  const toggle = (email: string) => {
    if (!user) return;
    setDoc(
      doc(db, "users", user.uid),
      { favouriteContacts: favourites.has(email) ? arrayRemove(email) : arrayUnion(email) },
      { merge: true },
    );
  };
  return { favourites, toggle };
}

function useIndexStatus() {
  const { user } = useAuth();
  const [status, setStatus] = useState<IndexStatus | null | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [canRead, setCanRead] = useState(false);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => {
      setStatus((snap.get("mailIndex") as IndexStatus) ?? null);
      setConnected(!!snap.get("gmail.email") && !snap.get("gmail.needsReconnect"));
      // Reading the mailbox: only users who hold one of the 100 Gmail-reading places.
      setCanRead(snap.get("gmail.canRead") === true);
    });
  }, [user]);
  return { status, connected, canRead };
}

/**
 * On an offer: people from the mailbox whose email domain matches the organization. Found by a plain
 * database query on the index, so it's automatic and free. Drafting an email is the only AI step.
 */
export function KnownPeople({ applicationId, organization, applyUrl }: { applicationId: string; organization: string; applyUrl?: string }) {
  const { user } = useAuth();
  const { status, connected, canRead } = useIndexStatus();
  const [people, setPeople] = useState<(Person & { id: string })[]>([]);
  const tokens = useMemo(() => offerTokens(organization, applyUrl), [organization, applyUrl]);
  const { favourites, toggle } = useFavourites();

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

  if (!connected && !people.length) return null; // no index to match against
  if (!canRead && !people.length) return null;
  if (connected && status?.status !== "ready" && !people.length) {
    return (
      <section className="rounded-xl border border-card-edge bg-card p-5 text-sm text-muted">
        BAPTOU is indexing your mailbox (no credit used). People you know at {organization} will show up here.
      </section>
    );
  }
  if (!people.length) return null; // nobody known there: stay quiet

  return (
    <section className="rounded-xl border border-card-edge bg-card p-5">
      <h2 className="font-medium">People you know at {organization}</h2>
      <p className="mt-1 text-sm text-muted">Found in your mailbox automatically, without using credits.</p>
      <ul className="mt-3 grid grid-cols-1 gap-2">
        {[...people]
          .sort((a, b) => Number(favourites.has(b.email)) - Number(favourites.has(a.email)))
          .map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              applicationId={applicationId}
              canDraft={connected && canRead}
              favourite={favourites.has(p.email)}
              onToggleFavourite={() => toggle(p.email)}
            />
          ))}
      </ul>
      <div className="mt-4">
        <ContactsPanel applicationId={applicationId} listOnly />
      </div>
    </section>
  );
}

export function PersonRow({
  person: p,
  applicationId,
  canDraft,
  favourite = false,
  onToggleFavourite,
}: {
  person: Person & { id: string };
  applicationId?: string;
  canDraft: boolean; // drafting reads the last conversation, so it needs Gmail connected
  favourite?: boolean;
  onToggleFavourite?: () => void;
}) {
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
    // On a phone the button wraps under the person (the details need the width); on a wide screen it sits on the right.
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-card-edge-soft p-3 text-sm">
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        {onToggleFavourite && (
          <button
            onClick={onToggleFavourite}
            aria-label={favourite ? `Remove ${p.name || p.email} from favourites` : `Add ${p.name || p.email} to favourites`}
            aria-pressed={favourite}
            title={favourite ? "Remove from favourites" : "Add to favourites"}
            className={`-m-1 shrink-0 p-1 text-lg leading-none ${favourite ? "text-amber-500" : "text-muted hover:text-amber-500"}`}
          >
            {favourite ? "★" : "☆"}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium [overflow-wrap:anywhere]">{p.name || p.email}</p>
          {p.name && <p className="text-muted [overflow-wrap:anywhere]">{p.email}</p>}
          <p className="line-clamp-2 text-muted">
            {p.sent} sent · {p.received} received · last {new Date(p.lastAt).toLocaleDateString()}
            {p.lastSubject && ` · “${p.lastSubject}”`}
          </p>
        </div>
      </div>
      {canDraft ? (
        <button onClick={draft} disabled={busy} className="rounded-lg border border-accent px-3 py-1.5 text-accent disabled:opacity-50">
          {busy ? "Writing…" : "Draft an email"}
        </button>
      ) : (
        <Link href="/profile" className="text-xs text-muted underline">
          Reconnect Gmail to draft
        </Link>
      )}
      {error && <p className="w-full text-red-600">{error}</p>}
    </li>
  );
}

// Words suggesting someone can help with an internship (recruiters, schools, careers services).
const HELPFUL = /recrut|recruit|talent|rh\b|hr\b|human resources|ressources humaines|stage|intern|alternan|carri|career|campus|alumni|professeur|professor|prof\b|universit|ecole|school|mentor|manager|entretien|interview|candidature|application/i;

/** Contacts page: everyone in the mail index, searchable, likely helpers first. Free; drafting uses AI. */
export function MailIndexPanel() {
  const { user } = useAuth();
  const { status, connected, canRead } = useIndexStatus();
  const [people, setPeople] = useState<(Person & { id: string })[]>([]);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now()); // for recency scoring; stable during the session
  const { favourites, toggle } = useFavourites();
  const [onlyFavourites, setOnlyFavourites] = useState(false);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "mailIndex"), orderBy("lastAt", "desc"), limit(1000));
    return onSnapshot(q, (snap) => setPeople(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Person) }))));
  }, [user, connected]);

  const ranked = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const yearMs = 365 * 24 * 3600 * 1000;
    return people
      .filter((p) => !onlyFavourites || favourites.has(p.email))
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
  }, [people, filter, now, onlyFavourites, favourites]);
  const favouriteRows = ranked.filter((p) => favourites.has(p.email));
  const otherRows = ranked.filter((p) => !favourites.has(p.email));

  async function refresh() {
    setError(null);
    try {
      await refreshMailIndex();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  if (connected && !canRead && !people.length) {
    return (
      <section className="rounded-xl border border-card-edge bg-card p-5 text-sm">
        <h2 className="font-medium">People in your mailbox</h2>
        <p className="mt-1 text-muted">Finding people in your mailbox is reserved for BAPTOU&apos;s first 100 users for now. It will open to everyone soon.</p>
      </section>
    );
  }
  if (!connected && !people.length) {
    return (
      <section className="rounded-xl border border-card-edge bg-card p-5 text-sm">
        <Link href="/profile" className="text-accent">Connect Gmail</Link> to see the people in your mailbox.
      </section>
    );
  }

  const working = status?.status === "queued" || status?.status === "running";
  return (
    <section className="rounded-xl border border-card-edge bg-card p-5">
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
        {connected ? (
          <button onClick={refresh} disabled={working} className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">
            {working ? "Updating…" : "Update now"}
          </button>
        ) : (
          <Link href="/profile" className="text-sm text-accent">
            Reconnect Gmail to update
          </Link>
        )}
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
      {favourites.size > 0 && (
        <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={onlyFavourites} onChange={(e) => setOnlyFavourites(e.target.checked)} />
          Favourites only
        </label>
      )}

      {favouriteRows.length > 0 && (
        <>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">★ Favourites</p>
          <ul className="mt-2 grid grid-cols-1 gap-2">
            {favouriteRows.map((p) => (
              <PersonRow key={p.id} person={p} canDraft={connected} favourite onToggleFavourite={() => toggle(p.email)} />
            ))}
          </ul>
        </>
      )}

      {otherRows.length > 0 && (
        <>
          {favouriteRows.length > 0 && (
            <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Everyone else</p>
          )}
          <ul className="mt-2 grid grid-cols-1 gap-2">
            {otherRows.slice(0, shown).map((p) => (
              <PersonRow key={p.id} person={p} canDraft={connected} onToggleFavourite={() => toggle(p.email)} />
            ))}
          </ul>
        </>
      )}
      <div className="mt-3 flex gap-4 text-sm text-muted">
        {otherRows.length > shown && (
          <button onClick={() => setShown((n) => n + 20)} className="hover:text-foreground">
            Show more ({otherRows.length - shown} left)
          </button>
        )}
        {shown > 20 && (
          <button onClick={() => setShown(20)} className="hover:text-foreground">
            Show less
          </button>
        )}
      </div>
    </section>
  );
}
