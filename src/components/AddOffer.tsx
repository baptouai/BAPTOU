"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

const addApplicationFromUrl = httpsCallable<
  { url: string; searchId?: string; force?: boolean },
  { applicationId: string; existed: boolean }
>(functions, "addApplicationFromUrl", { timeout: 300_000 });

/** "Add an offer you found": paste a link, BAPTOU reads it and opens it in the usual format. */
export function AddOffer({ searchId, noun }: { searchId?: string; noun: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(force = false) {
    setBusy(true);
    setError(null);
    try {
      const { data } = await addApplicationFromUrl({ url: url.trim(), searchId, force });
      router.push(`/applications/view?id=${data.applicationId}`);
    } catch (e) {
      const details = (e as { details?: { closed?: boolean; notPosting?: boolean } }).details;
      const message = e instanceof Error ? e.message : "Something went wrong";
      if ((details?.closed || details?.notPosting) && !force && confirm(`${message} Add it anyway?`)) {
        await add(true);
        return;
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-4 text-sm text-accent hover:underline">
        + Add {noun === "programmes" ? "a programme" : "an offer"} you found
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      className="mt-4 grid gap-2 rounded-xl border border-card-edge-soft bg-card p-4 text-sm"
    >
      <p className="font-medium">Paste the link to the posting</p>
      <p className="text-muted">BAPTOU reads it and adds it here in the usual format, ready to prepare (about $0.05).</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="url"
          required
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          placeholder="https://…"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2"
        />
        <button disabled={busy || !url.trim()} className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
          {busy ? "Reading the posting… (up to 1 min)" : "Add"}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-lg px-3 py-2 text-muted">
          Cancel
        </button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}
