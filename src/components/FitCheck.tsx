"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { RichText } from "@/components/RichText";
import type { ChatMessage, FitVerdict } from "@/lib/types";

const askAboutOffer = httpsCallable<{ applicationId: string; question: string }>(functions, "askAboutOffer", {
  timeout: 300_000,
});

export const verdictLabel: Record<FitVerdict, { text: string; className: string }> = {
  good_fit: { text: "Good fit", className: "bg-green-500/10 text-green-700 dark:text-green-400" },
  uncertain: { text: "Not sure", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  poor_fit: { text: "Poor fit", className: "bg-red-500/10 text-red-700 dark:text-red-400" },
};

const STARTER = "Is this really for me? Give me the honest pros and cons given my profile and goals.";

/** "Is this for me?": ask BAPTOU questions about one offer and get an honest verdict. */
export function FitCheck({ applicationId }: { applicationId: string }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<(ChatMessage & { id: string })[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "applications", applicationId, "chat"), orderBy("createdAt"));
    return onSnapshot(q, (snap) => setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ChatMessage) }))));
  }, [user, applicationId]);

  async function ask(text: string) {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await askAboutOffer({ applicationId, question: text.trim() });
      setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const last = [...messages].reverse().find((m) => m.role === "baptou");

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-medium">Is this for me?</h2>
      <p className="mt-1 text-sm text-muted">
        Ask BAPTOU anything about this offer. It researches the organization and gives you an honest opinion.
      </p>

      {messages.length === 0 && !busy && (
        <button onClick={() => ask(STARTER)} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">
          Ask if it&apos;s really for me
        </button>
      )}

      <ul className="mt-4 grid gap-3">
        {messages.map((m) => (
          <li
            key={m.id}
            className={m.role === "user" ? "ml-8 rounded-lg bg-accent/10 p-3 text-sm" : "mr-8 rounded-lg border border-border p-3 text-sm"}
          >
            {m.verdict && (
              <p className="mb-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${verdictLabel[m.verdict].className}`}>
                  {verdictLabel[m.verdict].text}
                </span>
                <span className="ml-2 text-muted">{m.verdictReason}</span>
              </p>
            )}
            {m.role === "user" ? <p className="whitespace-pre-wrap">{m.text}</p> : <RichText text={m.text} />}
          </li>
        ))}
      </ul>

      {last?.followUpQuestions?.length ? (
        <div className="mt-3 text-sm">
          <p className="text-muted">BAPTOU would like to know:</p>
          <ul className="mt-1 grid gap-1">
            {last.followUpQuestions.map((q) => (
              <li key={q}>
                <button onClick={() => setQuestion(`${q}\n→ `)} className="text-left text-accent">
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(messages.length > 0 || busy) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
          className="mt-3 flex flex-col gap-2 sm:flex-row"
        >
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="Ask a question or answer BAPTOU's"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <button disabled={busy || !question.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Thinking… (up to 1 min)" : "Ask"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
