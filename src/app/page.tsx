"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { LanguageSwitch, useI18n } from "@/lib/i18n";
import { ThemeSwitch } from "@/components/ThemeSwitch";

export default function Home() {
  const { user, loading, signIn } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  useEffect(() => {
    if (user) router.replace("/dashboard");
  }, [user, router]);

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center px-4 py-16">
      <ThemeSwitch className="absolute left-4 top-4" />
      <LanguageSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-md text-center">
        <Image src="/logo.svg" alt="" width={72} height={72} className="mx-auto mb-6" priority />
        <h1 className="text-5xl font-bold tracking-tight">BAPTOU</h1>
        <p className="mt-4 text-lg text-muted">
          {t(
            "Your AI agent for internships, jobs, alternances and master's applications. It finds offers that fit you, prepares each application and writes your letters. Nothing is sent without your approval.",
          )}
        </p>
        <button
          onClick={signIn}
          disabled={loading}
          className="mt-8 w-full rounded-lg bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          {t("Continue with Google")}
        </button>
        <p className="mt-4 text-sm text-muted">
          <a href="https://baptou.com" className="hover:underline">{t("About BAPTOU and pricing")}</a>
          {" · "}
          <a href="https://baptou.com/privacy" className="hover:underline">{t("Privacy policy")}</a>
        </p>
      </div>
    </main>
  );
}
