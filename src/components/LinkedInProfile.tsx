"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { errorText, useI18n } from "@/lib/i18n";

/** "linkedin.com/in/jane-doe/?trk=…" (any form, with or without https) -> "https://www.linkedin.com/in/jane-doe". */
function normalize(input: string) {
  const m = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(input.trim());
  return m ? `https://www.linkedin.com/in/${m[1]}` : null;
}

/**
 * The student's LinkedIn profile link, saved on users/{uid}.linkedinUrl (kept apart from the AI-built profile,
 * so rebuilding it never erases it). BAPTOU puts it in application forms and emails that ask for it.
 */
export function LinkedInProfile() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState<string | null>(null); // null: not editing
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setSaved((snap.get("linkedinUrl") as string | undefined) ?? ""));
  }, [user]);

  async function store(url: string) {
    if (!user) return;
    setError(null);
    try {
      await setDoc(doc(db, "users", user.uid), { linkedinUrl: url }, { merge: true });
      setDraft(null);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const url = normalize(draft ?? "");
    if (!url) {
      setError(t("That doesn't look like a LinkedIn profile link (linkedin.com/in/…)."));
      return;
    }
    await store(url);
  }

  const editing = draft !== null || !saved;
  return (
    <section className="mt-8 rounded-xl border border-card-edge bg-card p-5">
      <h2 className="text-xl font-semibold">{t("LinkedIn profile")}</h2>
      <p className="mt-1 text-sm text-muted">{t("BAPTOU adds it to application forms and emails that ask for it.")}</p>

      {editing ? (
        <form onSubmit={save} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={draft ?? ""}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="url"
            autoComplete="url"
            placeholder="linkedin.com/in/your-name"
            aria-label={t("LinkedIn profile")}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button disabled={!draft?.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {t("Save")}
            </button>
            {saved && (
              <button type="button" onClick={() => setDraft(null)} className="rounded-lg px-3 py-2 text-sm text-muted">
                {t("Cancel")}
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <a href={saved} target="_blank" rel="noopener noreferrer" className="text-accent [overflow-wrap:anywhere]">
            {saved.replace(/^https:\/\/www\./, "")} ↗
          </a>
          <button onClick={() => setDraft(saved)} className="text-muted underline">
            {t("Change")}
          </button>
          <button onClick={() => store("")} className="text-muted underline">
            {t("Remove")}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <p className="mt-3 text-xs text-muted">
        {t("LinkedIn doesn't let BAPTOU read profiles. To use what's on yours too, open your profile on LinkedIn, choose More (or Resources) then Save to PDF, and upload that PDF above as “Other”.")}
      </p>
    </section>
  );
}
