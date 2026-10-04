import { ContactsPanel } from "@/components/Contacts";

export default function ContactsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Contacts</h1>
      <p className="mt-1 mb-6 text-muted">
        People from your mailbox who could help you land an internship, each with a first email to send.
      </p>
      <ContactsPanel />
    </div>
  );
}
