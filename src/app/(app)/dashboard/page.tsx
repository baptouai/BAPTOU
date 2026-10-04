"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { UsageMeter } from "@/components/UsageMeter";

const steps = [
  { href: "/profile", title: "1. Add your documents", text: "CVs, transcripts, past motivation letters." },
  { href: "/applications?search=new", title: "2. Start a search", text: "An internship or a master's programme. Each search gets its own tab." },
  { href: "/applications", title: "3. Review suggestions", text: "Say what interests you; BAPTOU prepares those applications." },
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
