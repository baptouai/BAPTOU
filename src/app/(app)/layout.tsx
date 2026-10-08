"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { LanguageSwitch, useI18n } from "@/lib/i18n";
import { GmailReconnectBanner } from "@/components/GmailConnect";
import { AccountSettings } from "@/components/AccountSettings";
import { usePlan } from "@/lib/plan";

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/applications", label: "Applications" },
  { href: "/contacts", label: "Contacts" },
  { href: "/profile", label: "Profile" },
  { href: "/plans", label: "Plans" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const { plan } = usePlan();
  // BAPTOU is for subscribers (paid or gifted): without either, only the Plans page and account settings.
  // The server and the database rules enforce the same; this only spares the student dead ends.
  const locked = !!plan && !plan.entitlement && !plan.failed;

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  if (loading || !user) {
    return <div className="flex flex-1 items-center justify-center text-muted">{t("Loading…")}</div>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-card">
        {/* On a phone the menu gets its own row under the logo, so every item stays visible. */}
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold tracking-tight">
            <Image src="/logo.svg" alt="" width={24} height={24} />
            BAPTOU
          </Link>
          <nav className="order-last flex w-full justify-between gap-2.5 scroll-row text-sm sm:order-none sm:w-auto sm:flex-1 sm:justify-start sm:gap-4">
            {(locked ? nav.filter((item) => item.href === "/plans") : nav).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  pathname.startsWith(item.href) ? "font-medium text-accent" : "text-muted"
                }
              >
                {t(item.label)}
              </Link>
            ))}
          </nav>
          <LanguageSwitch className="ml-auto sm:ml-0" />
          <button onClick={logOut} className="text-sm text-muted">
            {t("Sign out")}
          </button>
        </div>
      </header>
      {!locked && <GmailReconnectBanner />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {locked && !pathname.startsWith("/plans") ? <ChoosePlan email={user.email ?? ""} /> : children}
      </main>
    </div>
  );
}

/** What a signed-in user without a subscription or gift sees instead of the app. */
function ChoosePlan({ email }: { email: string }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-6">
      <section className="rounded-xl border border-card-edge bg-card p-6">
        <h1 className="text-2xl font-semibold">{t("Choose a plan to start")}</h1>
        <p className="mt-2 text-muted">
          {t("BAPTOU is available with a subscription: daily searches, applications prepared in each form's format, letters and emails.")}
        </p>
        <Link href="/plans" className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 font-medium text-white">
          {t("See plans")}
        </Link>
        {email && (
          <p className="mt-4 text-sm text-muted">
            {t("Were you given a subscription? It's linked to an email address: you're signed in as {email}. If it was sent to another address, sign out and sign in with that one.", { email })}
          </p>
        )}
      </section>
      <AccountSettings />
    </div>
  );
}
