"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot, type Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { Profile } from "@/lib/types";

const buildProfile = httpsCallable(functions, "buildProfile", { timeout: 300_000 });

export function ProfileSummary({ hasDocuments }: { hasDocuments: boolean }) {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Timestamp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => {
      setProfile((snap.get("profile") as Profile) ?? null);
      setUpdatedAt((snap.get("profileUpdatedAt") as Timestamp) ?? null);
    });
  }, [user]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await buildProfile();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Your profile</h2>
          <p className="text-sm text-muted">
            {updatedAt ? `Built ${updatedAt.toDate().toLocaleString()}` : "BAPTOU reads your documents and summarizes your background."}
          </p>
        </div>
        <button
          onClick={run}
          disabled={busy || !hasDocuments}
          className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Reading your documents…" : profile ? "Rebuild profile" : "Build my profile"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {profile && (
        <div className="mt-4 grid gap-4 rounded-xl border border-card-edge bg-card p-5 text-sm">
          <div>
            <p className="text-lg font-medium">{profile.fullName}</p>
            <p className="text-muted">{profile.headline}</p>
          </div>
          <Block title="Education">
            {profile.education.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.degree} in {e.field}</span>, {e.institution} ({e.country}), {e.startYear}–{e.endYear}
                {e.grade && <span className="text-muted"> · {e.grade}</span>}
              </li>
            ))}
          </Block>
          <Block title="Experience">
            {profile.experience.map((x, i) => (
              <li key={i}>
                <span className="font-medium">{x.role}</span>, {x.organization} <span className="text-muted">({x.period})</span>
              </li>
            ))}
          </Block>
          <Tags title="Skills" items={profile.skills} />
          <Tags title="Languages" items={profile.languages.map((l) => `${l.language} (${l.level})`)} />
          <Block title="Strengths">{profile.strengths.map((s, i) => <li key={i}>{s}</li>)}</Block>
          <Block title="Points to address">{profile.gaps.map((s, i) => <li key={i}>{s}</li>)}</Block>
          {profile.writingStyle && (
            <div>
              <p className="font-medium">Your writing style</p>
              <p className="mt-1 text-muted">{profile.writingStyle}</p>
            </div>
          )}
          <Tags title="Suggested internship roles" items={profile.suggestedTargets.internshipRoles} />
          <Tags title="Suggested master's fields" items={profile.suggestedTargets.mastersFields} />
        </div>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">{children}</ul>
    </div>
  );
}

function Tags({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="font-medium">{title}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {items.map((t) => (
          <span key={t} className="rounded-full border border-border px-2 py-0.5">{t}</span>
        ))}
      </div>
    </div>
  );
}
