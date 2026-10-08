// Keep in sync with looksGeneric in functions/src/postings.ts.

const JOB_PARAM = /[?&](jk|jid|jl|job_?id|gh_jid|req(uisition)?_?id|posting_?id|id)=/i;
const SEARCH_PARAM = /[?&](q|query|keywords?|search|kw|k|what)=/i;

/** A link to a careers section or a list of offers rather than to one posting (e.g. a job board's search results). */
export function looksGeneric(url?: string) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "");
    const last = path.split("/").pop() ?? "";
    if (JOB_PARAM.test(u.search)) return false; // one posting, picked by its id
    // Search results and lists of offers (e.g. indeed.com/q-intern-l-miami-jobs.html, ziprecruiter.com/Jobs/
    // Intern/-in-Miami,FL, glassdoor …-SRCH_…), whatever numbers their links carry.
    if (/srch_|\/jobs?\/search|\/search-jobs/.test(path) || /(^|-)jobs(-|\.|$)/.test(last) || last.startsWith("-in-")) return true;
    if (SEARCH_PARAM.test(u.search)) return true;
    if (/\d{3,}|[a-f0-9]{10,}/.test(path + u.search)) return false; // posting ids
    if (!last) return true;
    return /^(careers?|jobs?|vacanc(y|ies)|opportunit(y|ies)|graduates?|graduate-(opportunities|programmes?|programs?|jobs)|early-careers?|internships?|students?|placements?|join-us|work-with-us|join|recrutement|emplois?|offres?(-d-emploi)?|stages?|alternances?|nous-rejoindre|search|search-results|en|fr|int-en)$/.test(last);
  } catch {
    return false;
  }
}

const hasId = (u: URL) => /\d{3,}|[a-f0-9]{8,}/i.test(u.pathname + u.search);

/**
 * The link behind "Open the application form": the form's own page when BAPTOU found one at least as
 * specific as the posting, otherwise the posting itself (never a general careers page).
 */
export function formLink(formUrl: string | undefined, applyUrl: string | undefined) {
  try {
    const form = new URL(formUrl ?? "");
    const posting = applyUrl ? new URL(applyUrl) : null;
    const specific =
      /^https?:$/.test(form.protocol) &&
      !looksGeneric(form.href) &&
      (!posting || form.href.startsWith(posting.href.replace(/\/+$/, "")) || hasId(form) || !hasId(posting));
    if (specific) return form.href;
  } catch {
    // not a usable link
  }
  return applyUrl || formUrl || "";
}
