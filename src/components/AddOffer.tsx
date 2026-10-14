"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import { errorText, useI18n } from "@/lib/i18n";

const addApplicationFromUrl = httpsCallable<
  { url?: string; text?: string; searchId?: string; force?: boolean },
  { applicationId: string; existed: boolean }
>(functions, "addApplicationFromUrl", { timeout: 300_000 });

/**
 * "Add an offer you found": paste a link, or the offer's text when its page needs a login (e.g. the school's
 * JobTeaser). BAPTOU reads it and opens it in the usual format.
 */
export function AddOffer({ searchId, noun }: { searchId?: string; noun: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"link" | "text">("link");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  async function add(force = false) {
    setBusy(true);
    setError(null);
    try {
      const { data } = await addApplicationFromUrl(
        mode === "text"
          ? { text: text.trim(), url: url.trim() || undefined, searchId, force }
          : { url: url.trim(), searchId, force },
      );
      router.push(`/applications/view?id=${data.applicationId}`);
    } catch (e) {
      const details = (e as { details?: { closed?: boolean; notPosting?: boolean } }).details;
      const message = errorText(e, t);
      if ((details?.closed || details?.notPosting) && !force && confirm(`${message} ${t("Add it anyway?")}`)) {
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
        + {t(noun === "programmes" ? "Add a programme you found" : "Add an offer you found")}
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
      <div role="tablist" className="flex gap-1 text-sm">
        {(["link", "text"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            disabled={busy}
            className={`rounded-lg px-3 py-1 ${mode === m ? "bg-accent/10 font-medium text-accent" : "text-muted"}`}
          >
            {t(m === "link" ? "Paste a link" : "Paste the offer text")}
          </button>
        ))}
      </div>
      {mode === "link" ? (
        <>
          <p className="font-medium">{t("Paste the link to the posting")}</p>
          <p className="text-muted">
            {t("BAPTOU reads it and adds it here in the usual format, ready to prepare (about 1% of your monthly allowance).")}
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">{t("Paste the whole offer")}</p>
          <p className="text-muted">
            {t("For offers BAPTOU can't open, like those on your school's JobTeaser: select the whole offer page, copy it and paste it here. BAPTOU looks for the same posting on the company's own site and prepares it as usual (about 1% of your monthly allowance).")}
          </p>
          <textarea
            required
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            rows={8}
            maxLength={20_000}
            placeholder={t("Title, company, place, dates, description, profile sought…")}
            className="rounded-lg border border-border bg-background px-3 py-2"
          />
        </>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="url"
          required={mode === "link"}
          autoFocus={mode === "link"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          placeholder={mode === "link" ? "https://…" : t("Link to the offer (optional)")}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2"
        />
        <button
          disabled={busy || (mode === "link" ? !url.trim() : text.trim().length < 80)}
          className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {t(busy ? "Reading the posting… (up to 1 min)" : "Add")}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-lg px-3 py-2 text-muted">
          {t("Cancel")}
        </button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}
