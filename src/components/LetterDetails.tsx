"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { errorText, useI18n } from "@/lib/i18n";
import type { LetterContact } from "@/lib/letterSender";

const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

/**
 * "For your letters": the address, phone and email at the top of every motivation letter, and the signature
 * above the typed name. Saved on users/{uid} (letterContact, signaturePath) and in Storage.
 */
export function LetterDetails() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [saved, setSaved] = useState<LetterContact>({});
  const [draft, setDraft] = useState<LetterContact | null>(null); // null: showing the saved values
  const [signaturePath, setSignaturePath] = useState<string>();
  const [signatureUrl, setSignatureUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => {
      setSaved((snap.get("letterContact") as LetterContact | undefined) ?? {});
      setSignaturePath(snap.get("signaturePath") as string | undefined);
    });
  }, [user]);

  useEffect(() => {
    if (!signaturePath) return;
    let live = true;
    getDownloadURL(ref(storage, signaturePath)).then((url) => live && setSignatureUrl(url)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signaturePath]);

  const values = draft ?? saved;
  const set = (k: keyof LetterContact) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft({ ...values, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !draft) return;
    setError(null);
    try {
      const clean = { address: draft.address?.trim() ?? "", phone: draft.phone?.trim() ?? "", email: draft.email?.trim() ?? "" };
      await setDoc(doc(db, "users", user.uid), { letterContact: clean }, { merge: true });
      setDraft(null);
      setSavedAt(Date.now());
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function uploadSignature(files: FileList | null) {
    const file = files?.[0];
    if (!user || !file) return;
    setError(null);
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setError(t("The signature must be a PNG or JPG image."));
    if (file.size > MAX_SIGNATURE_BYTES) return setError(t("The signature image must be under 2 MB."));
    setBusy(true);
    try {
      const path = `users/${user.uid}/signature/signature-${Date.now()}.${file.type === "image/png" ? "png" : "jpg"}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      const previous = signaturePath;
      await setDoc(doc(db, "users", user.uid), { signaturePath: path }, { merge: true });
      if (previous) await deleteObject(ref(storage, previous)).catch(() => undefined);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function removeSignature() {
    if (!user || !signaturePath) return;
    await setDoc(doc(db, "users", user.uid), { signaturePath: "" }, { merge: true });
    await deleteObject(ref(storage, signaturePath)).catch(() => undefined);
    setSignatureUrl(undefined);
  }

  const input = "rounded-lg border border-border bg-background px-3 py-2 text-sm";
  return (
    <section className="mt-8 rounded-xl border border-card-edge bg-card p-5">
      <h2 className="text-xl font-semibold">{t("For your letters")}</h2>
      <p className="mt-1 text-sm text-muted">
        {t("Shown at the top of every motivation letter, with your name; your signature goes above your name at the bottom.")}
      </p>

      <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm sm:row-span-2">
          <span className="text-muted">{t("Postal address")}</span>
          <textarea value={values.address ?? ""} onChange={set("address")} rows={4} placeholder={t("Street\nPostcode and town\nCountry")} className={input} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">{t("Phone")}</span>
          <input value={values.phone ?? ""} onChange={set("phone")} inputMode="tel" autoComplete="tel" placeholder="+33 6 12 34 56 78" className={input} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">{t("Email")}</span>
          <input value={values.email ?? ""} onChange={set("email")} inputMode="email" autoComplete="email" placeholder={user?.email ?? ""} className={input} />
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button disabled={!draft} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {t("Save")}
          </button>
          {draft && (
            <button type="button" onClick={() => setDraft(null)} className="text-sm text-muted">
              {t("Cancel")}
            </button>
          )}
          {!draft && savedAt > 0 && <span className="text-sm text-muted">{t("Saved")}</span>}
        </div>
      </form>

      <div className="mt-6">
        <p className="text-sm font-medium">{t("Signature")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          {signaturePath && signatureUrl ? (
            // A plain img: the signature comes from Storage at its own size.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={signatureUrl} alt={t("Your signature")} className="h-16 max-w-56 rounded border border-border bg-white object-contain p-1" />
          ) : (
            <p className="text-sm text-muted">{t("No signature yet.")}</p>
          )}
          <label className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm">
            {busy ? t("Uploading…") : t(signaturePath ? "Replace" : "Upload a signature")}
            <input type="file" accept="image/png,image/jpeg" className="hidden" disabled={busy} onChange={(e) => uploadSignature(e.target.files)} />
          </label>
          {signaturePath && (
            <button onClick={removeSignature} className="text-sm text-muted underline">
              {t("Remove")}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">
          {t("Sign in black ink on white paper, take a photo, crop it tight. A PNG with a transparent background looks best.")}
        </p>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}
