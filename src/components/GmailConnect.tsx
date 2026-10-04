"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { GmailConnection } from "@/lib/types";

const gmailAuthUrl = httpsCallable<{ returnTo: string }, { url: string }>(functions, "gmailAuthUrl");
const gmailDisconnect = httpsCallable<{ clearIndex: boolean }, { ok: boolean }>(functions, "gmailDisconnect");

const callbackMessage: Record<string, string> = {
  connected: "Gmail connected.",
  cancelled: "Gmail connection cancelled.",
  expired: "The connection took too long. Try again.",
  error: "Couldn't connect Gmail. Try again.",
};

/** Shown on every page when Google has expired BAPTOU's Gmail access (weekly while the Google app is in Testing). */
export function GmailReconnectBanner() {
  const { user } = useAuth();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setExpired(snap.get("gmail.needsReconnect") === true));
  }, [user]);

  if (!expired) return null;
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10">
      <p className="mx-auto max-w-5xl px-4 py-2 text-sm text-amber-800 dark:text-amber-300">
        Your Gmail connection expired. <a href="/profile" className="font-medium underline">Reconnect Gmail</a> to keep
        finding contacts and sending emails.
      </p>
    </div>
  );
}

/** Connect / disconnect Gmail. BAPTOU reads to find past contacts and sends only emails approved in the app. */
export function GmailConnect() {
  const { user } = useAuth();
  const params = useSearchParams();
  const [gmail, setGmail] = useState<GmailConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = params.get("gmail");

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setGmail((snap.get("gmail") as GmailConnection) ?? null));
  }, [user]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      // Google sends the user back to this copy of the app (deployed or local).
      const { data } = await gmailAuthUrl({ returnTo: window.location.origin });
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  async function disconnect(clearIndex: boolean) {
    const question = clearIndex
      ? "Disconnect Gmail and delete the index of people in your mailbox? Offers will no longer show people you know until you reconnect and the index is rebuilt."
      : "Disconnect Gmail? BAPTOU loses access to your mailbox immediately. The index of people you know is kept, so offers still show them.";
    if (!confirm(question)) return;
    setBusy(true);
    await gmailDisconnect({ clearIndex }).catch(() => {});
    setBusy(false);
  }

  const connected = !!gmail?.email && !gmail.needsReconnect;

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="text-xl font-semibold">Gmail</h2>
          <p className="mt-1 text-sm text-muted">
            BAPTOU searches your mailbox for people who could help (recruiters, former managers, alumni…) and drafts
            emails that follow on from your past conversations. It only sends an email when you click “Approve &amp; send”.
          </p>
          {connected && <p className="mt-2 text-sm">Connected as <span className="font-medium">{gmail.email}</span></p>}
          {gmail?.needsReconnect && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">The connection expired. Reconnect to keep using it.</p>
          )}
        </div>
        {connected ? (
          <div className="flex flex-col items-end gap-1">
            <button onClick={() => disconnect(false)} disabled={busy} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">
              Disconnect
            </button>
            <button onClick={() => disconnect(true)} disabled={busy} className="text-xs text-red-600 underline disabled:opacity-50">
              Disconnect and clear index
            </button>
          </div>
        ) : (
          <button onClick={connect} disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Opening Google…" : gmail?.needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}
          </button>
        )}
      </div>
      {result && callbackMessage[result] && <p className="mt-3 text-sm">{callbackMessage[result]}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}
