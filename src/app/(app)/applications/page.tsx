import { ApplicationList } from "@/components/ApplicationList";

export default function ApplicationsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Internship suggestions</h1>
      <p className="mt-1 text-muted">Offers BAPTOU found for you, each with a drafted letter you can edit.</p>
      <ApplicationList
        type="internship"
        empty="No suggestions yet. BAPTOU will start searching once your profile is ready."
      />
    </div>
  );
}
