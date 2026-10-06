// Keep in sync with looksGeneric in functions/src/postings.ts.

/** A link to a careers section rather than to one posting (e.g. /careers/graduate-opportunities). */
export function looksGeneric(url?: string) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "");
    if (/\d{3,}|[a-f0-9]{10,}/.test(path + u.search)) return false; // posting ids
    const last = path.split("/").pop() ?? "";
    if (!last) return true;
    return /^(careers?|jobs?|vacanc(y|ies)|opportunit(y|ies)|graduates?|graduate-(opportunities|programmes?|programs?|jobs)|early-careers?|internships?|students?|placements?|join-us|work-with-us|join|recrutement|emplois?|offres?(-d-emploi)?|stages?|alternances?|nous-rejoindre|search|search-results|en|fr|int-en)$/.test(last);
  } catch {
    return false;
  }
}
