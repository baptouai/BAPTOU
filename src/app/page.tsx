"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function Home() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) router.replace("/dashboard");
  }, [user, router]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <Image src="/logo.svg" alt="" width={72} height={72} className="mx-auto mb-6" priority />
        <h1 className="text-5xl font-bold tracking-tight">BAPTOU</h1>
        <p className="mt-4 text-lg text-muted">
          Your AI agent for internships and master&apos;s applications. It finds
          opportunities, researches each organization and drafts your letters.
          Nothing is sent without your approval.
        </p>
        <button
          onClick={signIn}
          disabled={loading}
          className="mt-8 w-full rounded-lg bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          Continue with Google
        </button>
      </div>
    </main>
  );
}
