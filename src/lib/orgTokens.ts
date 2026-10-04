// Organization tokens: how an offer is matched with people in the mail index, without AI.
// Keep GENERIC in sync with functions/src/mailIndex.ts (which tokenizes email domains the same way).

const GENERIC = new Set([
  "www", "jobs", "job", "careers", "career", "apply", "recruiting", "recruitment", "talent", "boards", "mail", "email",
  "greenhouse", "lever", "workday", "myworkdayjobs", "smartrecruiters", "teamtailor", "welcometothejungle", "linkedin",
  "indeed", "glassdoor", "jobteaser", "workable", "recruitee", "bamboohr", "icims", "taleo", "successfactors",
  "com", "org", "net", "edu", "gov", "int", "info", "biz", "fr", "co", "uk", "de", "es", "it", "nl", "be", "ch", "io",
  "eu", "us", "ca", "au", "jp", "cn", "in", "ie", "at", "se", "dk", "no", "fi", "pt", "pl", "lu", "ac",
  "gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "icloud", "msn", "aol", "proton", "protonmail", "gmx",
  "orange", "free", "sfr", "laposte", "wanadoo", "bbox", "neuf", "numericable", "mac", "me", "ymail", "zoho",
]);
const STOP = new Set(["the", "and", "of", "for", "group", "groupe", "sa", "sas", "sarl", "ltd", "limited", "inc", "llc", "gmbh", "plc", "ag", "company", "co"]);

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Tokens an email domain could carry for this offer. "Oracle Red Bull Racing" on redbullracing.com gives
 * oracle, redbull, bullracing, redbullracing, oracleredbullracing… so a person @redbull.com or
 * @redbullracing.com matches. Firestore's array-contains-any takes at most 30 values.
 */
export function offerTokens(organization: string, applyUrl?: string): string[] {
  const words = norm(organization)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
  const tokens = new Set<string>();
  for (const w of words) if (w.length >= 3 && !GENERIC.has(w)) tokens.add(w);
  // Domains glue words together: every run of consecutive words, joined.
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 2; j <= words.length; j++) tokens.add(words.slice(i, j).join(""));
  }
  if (applyUrl) {
    try {
      for (const label of new URL(applyUrl).hostname.split(".")) {
        const l = norm(label).replace(/[^a-z0-9]/g, "");
        if (l.length >= 3 && !GENERIC.has(l) && !/^wd\d+$/.test(l)) tokens.add(l);
      }
    } catch {
      // not a URL
    }
  }
  return [...tokens].slice(0, 30);
}
