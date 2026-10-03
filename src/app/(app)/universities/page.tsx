import { ApplicationList } from "@/components/ApplicationList";

export default function UniversitiesPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Master&apos;s applications</h1>
      <p className="mt-1 text-muted">
        Programmes abroad, applied to directly on each university&apos;s website. BAPTOU prepares
        the statement, the answers and the document checklist; you submit on the portal.
      </p>
      <ApplicationList
        type="masters"
        empty="No programmes yet. BAPTOU will suggest some once your profile is ready."
      />
    </div>
  );
}
