import { Fragment } from "react";

// BAPTOU writes explanations as "- " bullet points with optional **bold** headings. This renders them
// consistently, and turns older paragraph text into bullets (one per sentence) so nothing reads as a wall.

type Block = { kind: "heading" | "bullet" | "para"; text: string };

const BULLET = /^\s*(?:[-•*]|\d+[.)])\s+/;
const HEADING = /^\s*\*\*([^*]+)\*\*:?\s*$/;

function sentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9“"(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseRich(text: string, bulletize = true): Block[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasBullets = lines.some((l) => BULLET.test(l));
  if (!hasBullets && bulletize) {
    const parts = lines.flatMap(sentences);
    if (parts.length > 1) return parts.map((t) => ({ kind: "bullet", text: t.replace(/\.$/, "") }));
  }
  return lines.map((l) =>
    HEADING.test(l)
      ? { kind: "heading", text: l.replace(HEADING, "$1") }
      : BULLET.test(l)
        ? { kind: "bullet", text: l.replace(BULLET, "") }
        : { kind: "para", text: l },
  );
}

/** **bold** inside a line. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-foreground">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Bullet points, short headings and paragraphs. `limit` shows only the first bullets (for cards);
 * `bulletize` turns multi-sentence paragraphs into bullets.
 */
export function RichText({
  text,
  limit,
  bulletize = true,
  className = "",
}: {
  text?: string | null;
  limit?: number;
  bulletize?: boolean;
  className?: string;
}) {
  if (!text?.trim()) return null;
  let blocks = parseRich(text, bulletize);
  if (limit) blocks = blocks.filter((b) => b.kind === "bullet").slice(0, limit);

  const out: React.ReactNode[] = [];
  let list: Block[] = [];
  const flush = () => {
    if (!list.length) return;
    out.push(
      <ul key={`ul-${out.length}`} className="grid gap-1">
        {list.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
            <span>
              <Inline text={b.text} />
            </span>
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const b of blocks) {
    if (b.kind === "bullet") {
      list.push(b);
      continue;
    }
    flush();
    out.push(
      b.kind === "heading" ? (
        <p key={`h-${out.length}`} className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted">
          {b.text}
        </p>
      ) : (
        <p key={`p-${out.length}`}>
          <Inline text={b.text} />
        </p>
      ),
    );
  }
  flush();
  return <div className={`grid gap-1.5 leading-relaxed ${className}`}>{out}</div>;
}
