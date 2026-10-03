"use client";

import { useState } from "react";

const REASONS = [
  "Wrong location",
  "Not my field",
  "Too senior / too junior",
  "Bad timing or duration",
  "Not interested in this company",
  "Unpaid or poorly paid",
];

/** Turns down a suggestion. The reason is saved so future searches avoid similar offers. */
export function DismissForm({ onDismiss }: { onDismiss: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-lg px-4 py-2 text-muted">
        Not for me
      </button>
    );
  }

  const reason = [...picked, details.trim()].filter(Boolean).join(". ");
  const toggle = (r: string) => setPicked((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));

  return (
    <div className="grid w-full gap-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">Why isn&apos;t it for you? BAPTOU will avoid similar offers.</p>
      <div className="flex flex-wrap gap-2">
        {REASONS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => toggle(r)}
            className={`rounded-full border px-3 py-1 text-sm ${picked.includes(r) ? "border-accent bg-accent/10 text-accent" : "border-border"}`}
          >
            {r}
          </button>
        ))}
      </div>
      <textarea
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        rows={2}
        placeholder="Details (optional), e.g. I want to stay in finance, not audit"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          disabled={!reason || busy}
          onClick={async () => {
            setBusy(true);
            await onDismiss(reason);
          }}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Dismiss this offer
        </button>
        <button onClick={() => setOpen(false)} className="rounded-lg px-4 py-2 text-sm text-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}
