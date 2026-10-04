"use client";

import { useState } from "react";

/**
 * One search tab. Click selects it; double-click turns the name into a field (Enter or leaving it saves,
 * Esc cancels). The rename state lives here, so nothing else re-renders while typing.
 */
export function SearchTab({
  name,
  active,
  dimmed = false,
  masters = false,
  badge = 0,
  onSelect,
  onRename,
}: {
  name: string;
  active: boolean;
  dimmed?: boolean;
  masters?: boolean;
  badge?: number; // offers to review
  onSelect: () => void;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  function finish(save: boolean) {
    if (draft === null) return; // Enter then blur: only the first one counts
    const next = draft.trim();
    setDraft(null);
    if (save && next && next !== name) onRename(next);
  }

  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        }}
        aria-label="Tab name"
        className="-mb-px w-52 border-b-2 border-accent bg-transparent px-4 py-2.5 text-sm font-medium outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onDoubleClick={() => setDraft(name)}
      title="Double-click to rename"
      className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm ${
        active ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-foreground"
      } ${dimmed ? "opacity-60" : ""}`}
    >
      {name}
      {masters && <span className="rounded border border-border px-1 text-[10px] uppercase">Master&apos;s</span>}
      {badge > 0 && (
        <span className="rounded-full bg-accent px-1.5 text-xs font-medium text-white" title={`${badge} to review`}>
          {badge}
        </span>
      )}
    </button>
  );
}
