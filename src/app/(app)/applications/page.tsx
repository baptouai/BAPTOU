import { ApplicationList } from "@/components/ApplicationList";
import { SearchPanel } from "@/components/SearchPanel";

export default function ApplicationsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Internships</h1>
      <p className="mt-1 text-muted">
        Tell BAPTOU what to look for. It searches once a day while a search is active and lists new offers below.
      </p>
      <SearchPanel />
      <h2 className="mt-8 text-xl font-semibold">Suggestions</h2>
      <ApplicationList
        type="internship"
        empty="No suggestions yet. Start a search above and BAPTOU will list the offers it finds here."
      />
    </div>
  );
}
