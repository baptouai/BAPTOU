"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { ApplicationList, type ApplicationItem } from "@/components/ApplicationList";
import { kindOf, SearchCard, SearchForm, type SearchItem } from "@/components/Searches";
import type { Application, Search } from "@/lib/types";

// The selected tab lives in the URL (?search=<id>, or ?search=new), so "Back" from an offer returns to it.
export default function ApplicationsPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <Applications />
    </Suspense>
  );
}

const OTHER = "other"; // offers whose search was deleted

function Applications() {
  const { user } = useAuth();
  const router = useRouter();
  const selected = useSearchParams().get("search");
  const [searches, setSearches] = useState<SearchItem[] | null>(null);
  const [apps, setApps] = useState<ApplicationItem[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  // Double-click a tab to rename it; Enter or leaving the field saves, Esc cancels.
  async function saveRename() {
    if (!user || !renaming) return;
    const name = renaming.name.trim();
    const search = searches?.find((s) => s.id === renaming.id);
    setRenaming(null);
    if (name && search && name !== search.name) {
      await updateDoc(doc(db, "users", user.uid, "searches", renaming.id), { name, updatedAt: serverTimestamp() });
    }
  }

  useEffect(() => {
    if (!user) return;
    const unsubSearches = onSnapshot(
      query(collection(db, "users", user.uid, "searches"), orderBy("createdAt", "asc")),
      (snap) => setSearches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Search) }))),
    );
    const unsubApps = onSnapshot(collection(db, "users", user.uid, "applications"), (snap) =>
      setApps(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Application) }))),
    );
    return () => {
      unsubSearches();
      unsubApps();
    };
  }, [user]);

  if (!searches || !apps) return <p className="text-muted">Loading…</p>;

  const offersOf = (id: string) =>
    id === OTHER ? apps.filter((a) => !searches.some((s) => s.id === a.searchId)) : apps.filter((a) => a.searchId === id);
  // A stopped search keeps its tab while it has offers; one with none disappears.
  const tabs = searches.filter((s) => s.status !== "stopped" || offersOf(s.id).length > 0);
  const orphans = offersOf(OTHER);
  const select = (id: string) => router.replace(`/applications?search=${id}`);

  const creating = selected === "new" || tabs.length === 0;
  const current = creating
    ? null
    : (tabs.find((s) => s.id === selected) ??
      (selected === OTHER && orphans.length ? null : (tabs.find((s) => s.status === "active") ?? tabs[0])));
  const showingOther = !creating && !current && selected === OTHER;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Applications</h1>
      <p className="mt-1 text-muted">
        One tab per search, so each one keeps its own suggestions. Double-click a tab to rename it. BAPTOU searches once
        a day while a search is active.
      </p>

      <div role="tablist" className="mt-5 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((s) => {
          const toReview = offersOf(s.id).filter((a) => a.status === "suggested").length;
          const active = current?.id === s.id;
          if (renaming?.id === s.id) {
            return (
              <input
                key={s.id}
                autoFocus
                value={renaming.name}
                onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                onBlur={saveRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                aria-label="Tab name"
                className="-mb-px w-48 border-b-2 border-accent bg-transparent px-4 py-2.5 text-sm font-medium outline-none"
              />
            );
          }
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              onClick={() => select(s.id)}
              onDoubleClick={() => setRenaming({ id: s.id, name: s.name })}
              title="Double-click to rename"
              className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm ${
                active ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-foreground"
              } ${s.status === "stopped" || s.status === "ended" ? "opacity-60" : ""}`}
            >
              {s.name}
              {kindOf(s) === "masters" && <span className="rounded border border-border px-1 text-[10px] uppercase">Master&apos;s</span>}
              {toReview > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-xs font-medium text-white" title={`${toReview} to review`}>
                  {toReview}
                </span>
              )}
            </button>
          );
        })}
        {orphans.length > 0 && (
          <button
            role="tab"
            aria-selected={showingOther}
            onClick={() => select(OTHER)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm ${
              showingOther ? "border-accent font-medium text-accent" : "border-transparent text-muted"
            }`}
          >
            Other
          </button>
        )}
        <button
          role="tab"
          aria-selected={creating}
          onClick={() => select("new")}
          className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm ${
            creating ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          + New search
        </button>
      </div>

      <div className="mt-5">
        {creating ? (
          <>
            {tabs.length === 0 && (
              <p className="mb-4 text-muted">
                Tell BAPTOU what you&apos;re looking for. Each search gets its own tab, for example one internship
                starting in November and another starting in April.
              </p>
            )}
            <SearchForm
              takenNames={searches.map((x) => x.name)}
              onDone={() => {
                if (tabs.length) router.replace("/applications");
              }}
              onCreated={(id) => select(id)}
            />
          </>
        ) : current ? (
          <>
            <SearchCard key={current.id} search={current} />
            <ApplicationList
              key={`list-${current.id}`}
              apps={offersOf(current.id)}
              empty={`No ${kindOf(current) === "masters" ? "programmes" : "offers"} yet. BAPTOU lists what this search finds here (the first run takes a few minutes).`}
            />
          </>
        ) : (
          <ApplicationList key="list-other" apps={orphans} empty="Nothing here." />
        )}
      </div>
    </div>
  );
}
