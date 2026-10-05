"use client";

import { useEffect, useState } from "react";
import { arrayRemove, arrayUnion, doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

// Suggestions only: any text can be added (e.g. a nationality missing from this list).
const SUGGESTIONS = [
  "Algerian", "American", "Argentinian", "Australian", "Austrian", "Belgian", "Brazilian", "British", "Bulgarian",
  "Cameroonian", "Canadian", "Chilean", "Chinese", "Colombian", "Croatian", "Cypriot", "Czech", "Danish", "Dutch",
  "Egyptian", "Estonian", "Finnish", "French", "German", "Greek", "Hungarian", "Icelandic", "Indian", "Indonesian",
  "Irish", "Israeli", "Italian", "Ivorian", "Japanese", "Korean", "Latvian", "Lebanese", "Lithuanian", "Luxembourgish",
  "Malaysian", "Maltese", "Mexican", "Moroccan", "New Zealander", "Nigerian", "Norwegian", "Pakistani", "Peruvian",
  "Polish", "Portuguese", "Romanian", "Russian", "Saudi", "Senegalese", "Singaporean", "Slovak", "Slovenian",
  "South African", "Spanish", "Swedish", "Swiss", "Tunisian", "Turkish", "Ukrainian", "Vietnamese",
];

/** One or more nationalities, saved on users/{uid}.nationalities. BAPTOU uses them for work permits, visas and fees. */
export function Nationalities() {
  const { user } = useAuth();
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setList((snap.get("nationalities") as string[]) ?? []));
  }, [user]);

  async function add() {
    const value = draft.trim();
    if (!user || !value) return;
    setDraft("");
    // Same spelling as the suggestion when it matches one, ignoring case ("british" -> "British").
    const name = SUGGESTIONS.find((s) => s.toLowerCase() === value.toLowerCase()) ?? value;
    if (list.some((n) => n.toLowerCase() === name.toLowerCase())) return;
    await setDoc(doc(db, "users", user.uid), { nationalities: arrayUnion(name) }, { merge: true });
  }

  async function remove(name: string) {
    if (!user) return;
    await setDoc(doc(db, "users", user.uid), { nationalities: arrayRemove(name) }, { merge: true });
  }

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-5">
      <h2 className="text-xl font-semibold">Nationalities</h2>
      <p className="mt-1 text-sm text-muted">
        BAPTOU uses them for work permits, visa questions on application forms, and tuition fees for master&apos;s programmes.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {list.map((n) => (
          <span key={n} className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-1 pl-3 pr-1 text-sm">
            {n}
            <button
              onClick={() => remove(n)}
              aria-label={`Remove ${n}`}
              className="flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-accent/20 hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            list="nationality-suggestions"
            placeholder={list.length ? "Add another" : "e.g. French"}
            aria-label="Add a nationality"
            className="w-40 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button disabled={!draft.trim()} className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">
            Add
          </button>
        </form>
        <datalist id="nationality-suggestions">
          {SUGGESTIONS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
    </section>
  );
}
