"use client";

import { Suspense, useEffect, useState } from "react";
import {
  addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp,
} from "firebase/firestore";
import { deleteObject, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { DocumentKind, UploadedDocument } from "@/lib/types";
import { ProfileSummary } from "@/components/ProfileSummary";
import { GmailConnect } from "@/components/GmailConnect";
import { Nationalities } from "@/components/Nationalities";
import { LinkedInProfile } from "@/components/LinkedInProfile";
import { LetterDetails } from "@/components/LetterDetails";
import { AccountSettings } from "@/components/AccountSettings";
import { errorText, useI18n } from "@/lib/i18n";

const kinds: { value: DocumentKind; label: string }[] = [
  { value: "cv", label: "CV" },
  { value: "transcript", label: "Grades / transcript" },
  { value: "motivation_letter", label: "Past motivation letter" },
  { value: "diploma", label: "Diploma" },
  { value: "other", label: "Other" },
];

const MAX_BYTES = 10 * 1024 * 1024;

export default function ProfilePage() {
  const { user } = useAuth();
  const [docs, setDocs] = useState<(UploadedDocument & { id: string })[]>([]);
  const [kind, setKind] = useState<DocumentKind>("cv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "documents"), orderBy("uploadedAt", "desc"));
    return onSnapshot(q, (snap) =>
      setDocs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UploadedDocument) }))),
    );
  }, [user]);

  async function upload(files: FileList | null) {
    if (!user || !files?.length) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_BYTES) throw new Error(t("{file} is larger than 10 MB", { file: file.name }));
        const storagePath = `users/${user.uid}/documents/${crypto.randomUUID()}-${file.name}`;
        await uploadBytes(ref(storage, storagePath), file, { contentType: file.type });
        await addDoc(collection(db, "users", user.uid, "documents"), {
          kind,
          fileName: file.name,
          storagePath,
          contentType: file.type,
          size: file.size,
          uploadedAt: serverTimestamp(),
        });
      }
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: UploadedDocument & { id: string }) {
    if (!user) return;
    await deleteObject(ref(storage, d.storagePath)).catch(() => {});
    await deleteDoc(doc(db, "users", user.uid, "documents", d.id));
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("Your documents")}</h1>
      <p className="mt-1 text-muted">{t("BAPTOU uses these to understand your background and to write letters in your style.")}</p>

      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-card-edge bg-card p-5 sm:flex-row sm:items-center">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as DocumentKind)}
          className="rounded-lg border border-border bg-background px-3 py-2"
        >
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>{t(k.label)}</option>
          ))}
        </select>
        <label className="cursor-pointer rounded-lg bg-accent px-4 py-2 text-center font-medium text-white">
          {busy ? t("Uploading…") : t("Upload PDF / Word")}
          <input
            type="file"
            multiple
            accept=".pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            disabled={busy}
            onChange={(e) => upload(e.target.files)}
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <ul className="mt-6 divide-y divide-border rounded-xl border border-card-edge bg-card">
        {docs.length === 0 && <li className="p-5 text-muted">{t("No documents yet.")}</li>}
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{d.fileName}</p>
              <p className="text-sm text-muted">{t(kinds.find((k) => k.value === d.kind)?.label ?? "Other")}</p>
            </div>
            <button onClick={() => remove(d)} className="text-sm text-red-600">{t("Delete")}</button>
          </li>
        ))}
      </ul>

      <Nationalities />

      <LinkedInProfile />

      <LetterDetails />

      <ProfileSummary hasDocuments={docs.length > 0} />

      {/* useSearchParams (Gmail connection result) needs a Suspense boundary. */}
      <Suspense>
        <GmailConnect />
      </Suspense>

      <AccountSettings />
    </div>
  );
}
