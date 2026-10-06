"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { usePlan } from "@/lib/plan";

const exportMyData = httpsCallable<void, unknown>(functions, "exportMyData", { timeout: 300_000 });
const deleteMyAccount = httpsCallable<{ confirm: string }, { ok: boolean }>(functions, "deleteMyAccount", { timeout: 300_000 });

const SITE_URL = "https://baptou-5041c.web.app";

/** Profile page: email notifications, a copy of all your data, and account deletion. */
export function AccountSettings() {
  return (
    <section className="mt-8 rounded-xl border border-card-edge bg-card p-5">
      <h2 className="text-xl font-semibold">Account</h2>
      <Notifications />
      <ExportData />
      <DeleteAccount />
    </section>
  );
}

function Notifications() {
  const { user } = useAuth();
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setOn(snap.get("notifyOffers") !== false));
  }, [user]);

  async function toggle() {
    if (!user) return;
    setOn(!on);
    await setDoc(doc(db, "users", user.uid), { notifyOffers: !on }, { merge: true });
  }

  return (
    <div className="mt-4 flex items-start justify-between gap-4">
      <div>
        <p className="font-medium">Email me about new offers</p>
        <p className="mt-0.5 text-sm text-muted">
          After a search finds new offers. An almost ideal offer (90% match or more) gets its own email.
        </p>
      </div>
      <button
        role="switch"
        aria-checked={on}
        onClick={toggle}
        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-border"}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

function ExportData() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await exportMyData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `baptou-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 flex items-start justify-between gap-4 border-t border-border pt-5">
      <div>
        <p className="font-medium">Export my data</p>
        <p className="mt-0.5 text-sm text-muted">
          A file with everything BAPTOU stores about you: profile, searches, offers, letters, contacts and usage.
        </p>
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      </div>
      <button onClick={download} disabled={busy} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">
        {busy ? "Preparing…" : "Download"}
      </button>
    </div>
  );
}

function DeleteAccount() {
  const { logOut } = useAuth();
  const { plan } = usePlan();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = plan?.entitlement?.kind;
  const paying = kind === "monthly" || kind === "annual";

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteMyAccount({ confirm: "DELETE" });
      await logOut().catch(() => {});
      window.location.assign(SITE_URL);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">Delete my account</p>
          <p className="mt-0.5 text-sm text-muted">Deletes your profile, files, searches, offers, letters and contacts. This can&apos;t be undone.</p>
        </div>
        {!open && (
          <button onClick={() => setOpen(true)} className="shrink-0 rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-600 dark:text-red-400">
            Delete…
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            <li>Everything BAPTOU stores about you is deleted, including your uploaded files.</li>
            <li>BAPTOU&apos;s access to your Gmail is revoked. Emails already sent stay in your mailbox.</li>
            {paying && <li>Your subscription stops now: no further payments, and no refund for the current period.</li>}
            <li>Payment records are kept by Stripe, as the law requires for accounting.</li>
          </ul>
          {/* Export first: there is no way back after this. */}
          <p className="mt-3 text-muted">Want a copy first? Use “Export my data” above.</p>
          <label className="mt-3 block">
            Type <span className="font-mono font-semibold">DELETE</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 block w-full max-w-xs rounded-lg border border-border bg-background px-3 py-1.5"
              autoComplete="off"
            />
          </label>
          {error && <p className="mt-2 text-red-600">{error}</p>}
          <div className="mt-3 flex gap-3">
            <button
              onClick={remove}
              disabled={typed.trim() !== "DELETE" || busy}
              className="rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete my account"}
            </button>
            <button onClick={() => { setOpen(false); setTyped(""); }} disabled={busy} className="text-muted hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
