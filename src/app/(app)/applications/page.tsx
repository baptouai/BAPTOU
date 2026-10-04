"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { ApplicationList, type ApplicationItem } from "@/components/ApplicationList";
import { kindOf, SearchCard, SearchForm, type SearchItem } from "@/components/Searches";
import { SearchTab } from "@/components/SearchTab";
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

const LAST_TAB_KEY = "baptou.applications.tab";
function readLastTab() {
  try {
    return localStorage.getItem(LAST_TAB_KEY);
  } catch {
    return null; // storage blocked (private window…): fall back to the default tab
  }
}
function saveLastTab(id: string) {
  try {
    localStorage.setItem(LAST_TAB_KEY, id);
  } catch {
    // not essential
  }
}

function Applications() {
  const { user } = useAuth();
  // Switching tabs is plain state: changing ?search= in the URL makes Next rebuild the page (reloading
  // the data and losing a tab being renamed). ?search= is only read on arrival (e.g. "Back" from an
  // offer); the last tab is remembered in this browser for the next visit.
  const fromUrl = useSearchParams().get("search");
  const [selected, setSelected] = useState<string | null>(() => fromUrl ?? readLastTab());
  const showTab = (id: string | null) => {
    setSelected(id);
    if (id && id !== "new") saveLastTab(id);
  };
  const [searches, setSearches] = useState<SearchItem[] | null>(null);
  const [apps, setApps] = useState<ApplicationItem[] | null>(null);

  async function rename(id: string, name: string) {
    if (!user) return;
    await updateDoc(doc(db, "users", user.uid, "searches", id), { name, updatedAt: serverTimestamp() });
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
  const select = (id: string) => showTab(id);

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
        {tabs.map((s) => (
          <SearchTab
            key={s.id}
            name={s.name}
            active={current?.id === s.id}
            dimmed={s.status === "stopped" || s.status === "ended"}
            masters={kindOf(s) === "masters"}
            badge={offersOf(s.id).filter((a) => a.status === "suggested").length}
            onSelect={() => select(s.id)}
            onRename={(name) => rename(s.id, name)}
          />
        ))}
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
                if (tabs.length) showTab(null);
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
