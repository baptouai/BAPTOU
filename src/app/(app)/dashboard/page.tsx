"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { UsageMeter } from "@/components/UsageMeter";

const steps = [
  { href: "/profile", title: "1. Add your documents", text: "CVs, transcripts, past motivation letters." },
  { href: "/applications", title: "2. Review suggestions", text: "Internships BAPTOU found for you, with drafted letters." },
  { href: "/universities", title: "3. Master's applications", text: "Programmes, deadlines and application packs." },
];

export default function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1 className="text-2xl font-semibold">Hi {user?.displayName?.split(" ")[0]} 👋</h1>
      <p className="mt-1 text-muted">Here&apos;s where to start.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {steps.map((s) => (
          <Link key={s.href} href={s.href} className="rounded-xl border border-border bg-card p-5 hover:border-accent">
            <h2 className="font-medium">{s.title}</h2>
            <p className="mt-1 text-sm text-muted">{s.text}</p>
          </Link>
        ))}
      </div>
      <div className="mt-6">
        <UsageMeter />
      </div>
    </div>
  );
}
