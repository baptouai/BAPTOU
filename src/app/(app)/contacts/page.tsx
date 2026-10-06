"use client";

import { ContactsPanel } from "@/components/Contacts";
import { MailIndexPanel } from "@/components/MailIndex";
import { useI18n } from "@/lib/i18n";

export default function ContactsPage() {
  const { t } = useI18n();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("Contacts")}</h1>
      <p className="mt-1 mb-6 text-muted">
        {t("People from your mailbox who could help you land an internship, a job or a place, each with a first email to send.")}
      </p>
      <div className="grid gap-6">
        <MailIndexPanel />
        <ContactsPanel />
      </div>
    </div>
  );
}
