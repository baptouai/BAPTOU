"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { ScrollReveal } from "@/components/ScrollReveal";
import { useAuth } from "@/lib/auth-context";
import { LanguageSwitch, useI18n } from "@/lib/i18n";
import { ThemeSwitch } from "@/components/ThemeSwitch";
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
  // BAPTOU is for subscribers (paid or gifted). Without a plan: the free first search (profile + one search,
  // whose offers stay readable afterwards), else only the Plans page and account settings.
  // The server and the database rules enforce the same; this only spares the student dead ends.
  const trial = plan && !plan.entitlement && !plan.failed ? (plan.trial ?? null) : null;
  const locked = !!plan && !plan.entitlement && !plan.failed && !trial;
  const items = locked ? nav.filter((item) => item.href === "/plans") : trial ? nav.filter((item) => item.href !== "/contacts") : nav;
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  if (loading || !user) {
    return <div className="flex flex-1 items-center justify-center text-muted">{t("Loading…")}</div>;
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* The poster gradient, with white pills for the menu. */}
      <header className="poster sticky top-0 z-20 shadow-[0_10px_30px_-20px_rgba(15,10,60,0.8)]">
        {/* On a phone the menu gets its own row under the logo, so every item stays visible. */}
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <ThemeSwitch />
          <Link href="/dashboard" className="-ml-3 flex items-center gap-2 font-black tracking-wide">
            <Image src="/logo-white.svg" alt="" width={28} height={28} />
            BAPTOU
          </Link>
          <nav className="order-last flex w-full justify-between gap-1 scroll-row text-sm sm:order-none sm:w-auto sm:flex-1 sm:justify-start sm:gap-1.5">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full px-3 py-1 transition-colors ${
                  pathname.startsWith(item.href) ? "bg-white font-bold text-[#312e81]" : "text-indigo-100 hover:bg-white/10 hover:text-white"
                }`}
              >
                {t(item.label)}
              </Link>
            ))}
          </nav>
          <LanguageSwitch className="ml-auto sm:ml-0" />
          <button onClick={logOut} className="text-sm text-indigo-100 hover:text-white">
            {t("Sign out")}
          </button>
        </div>
      </header>
      {!locked && !trial && <GmailReconnectBanner />}
      {trial && !pathname.startsWith("/plans") && <TrialBanner used={trial.used} />}
      <main ref={mainRef} className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {locked && !pathname.startsWith("/plans") ? <ChoosePlan email={user.email ?? ""} /> : children}
      </main>
      <ScrollReveal root={mainRef} />
    </div>
  );
}

/** Above every page while on the free first search, and after it. */
function TrialBanner({ used }: { used: boolean }) {
  const { t } = useI18n();
  return (
    <div className="poster border-t border-white/10">
      <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-indigo-100">
          {used
            ? t("Your free search is done. To prepare your applications (letters, forms) and get new offers every morning, choose a plan, from €11.49 a month.")
            : t("Your first search is free: add your CV, build your profile and start a search. BAPTOU finds offers that fit you.")}
        </p>
        <Link href="/plans" className={`w-fit shrink-0 rounded-full px-4 py-1.5 ${used ? "poster-cta" : "border border-white/40 font-semibold text-white hover:bg-white/10"}`}>
          {t("See plans")}
        </Link>
      </div>
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
