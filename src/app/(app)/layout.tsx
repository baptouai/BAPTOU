"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { LanguageSwitch, useI18n } from "@/lib/i18n";
import { GmailReconnectBanner } from "@/components/GmailConnect";

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
            {nav.map((item) => (
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
      <GmailReconnectBanner />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
