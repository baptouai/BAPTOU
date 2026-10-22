// The motivation letter laid out on one A4 page, as the student's school teaches it (Centrale Nantes,
// "CV & cover letters"): one font, 12 pt text and 14 pt for the name, the sender's details and the date at the
// top right, the recipient below on the left, the signature above the typed name. The paragraphs are justified
// (the student's choice), with hyphenation in the letter's language so the spacing stays even.
// French letters follow the French layout instead: sender at the top left, recipient on the right, "Ville, le …".
// The same markup is measured in the app (does it fit on one page?) and printed to PDF.

export type LetterLang = "en" | "fr";

export type LetterParts = {
  lang: LetterLang;
  name: string;
  senderLines: string[]; // address lines, phone, email
  recipientLines: string[];
  subject: string;
  body: string; // salutation to closing formula
  signatureUrl?: string;
};

const PAGE = { widthMm: 210, heightMm: 297, marginYMm: 20, marginXMm: 22 };
const SIZES = [12, 11.5, 11, 10.5]; // the text shrinks a little before it would spill onto a second page
const FONT = `Calibri, Carlito, "Segoe UI", Arial, sans-serif`;

export const LETTER_CSS = `
.bl-page{box-sizing:border-box;width:${PAGE.widthMm}mm;height:${PAGE.heightMm}mm;padding:${PAGE.marginYMm}mm ${PAGE.marginXMm}mm;background:#fff;color:#111;font-family:${FONT};line-height:1.32;overflow:hidden}
.bl-content p{margin:0 0 .75em;text-align:justify;-webkit-hyphens:auto;hyphens:auto}
.bl-name{font-size:1.17em;font-weight:700}
.bl-block{white-space:pre-line}
.bl-right{text-align:right}
.bl-half{margin-left:52%}
.bl-gap{height:1.6em}
.bl-subject{font-weight:700;margin-bottom:1.1em}
.bl-sign{margin-top:.4em}
.bl-sign img{display:block;height:16mm;max-width:60mm;object-fit:contain}
.bl-sign .bl-blank{height:16mm}
.bl-sign.bl-right img{margin-left:auto}
`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Language of a letter written before BAPTOU recorded it. */
export function guessLetterLang(body: string, postingLanguage?: string): LetterLang {
  if (/^\s*(madame|monsieur)/i.test(body) || /je vous prie|salutations distinguées|veuillez agréer/i.test(body)) return "fr";
  if (/^\s*dear\b/i.test(body)) return "en";
  return /fr/i.test(postingLanguage ?? "") ? "fr" : "en";
}

/** The letter's text without a typed name at the end (older letters had one; the page adds it under the signature). */
export function letterBody(text: string, name: string) {
  const lines = text.replace(/\s+$/, "").split("\n");
  const last = lines[lines.length - 1]?.trim().toLowerCase();
  if (name && last && (last === name.trim().toLowerCase() || name.toLowerCase().startsWith(last))) lines.pop();
  return lines.join("\n").replace(/\s+$/, "");
}

function dateLine(lang: LetterLang, senderLines: string[], when = new Date()) {
  if (lang === "fr") {
    const day = when.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    // The town from the address's postcode line ("44300 Nantes" -> "Nantes").
    const town = senderLines.map((l) => /^\s*\d{4,5}\s+(.+)$/.exec(l)?.[1]).find(Boolean);
    return town ? `${town.trim()}, le ${day}` : `Le ${day}`;
  }
  return when.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** The page's inner markup (inside a .bl-page element). */
export function letterMarkup(p: LetterParts) {
  const paragraphs = p.body
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const sender = `<div class="bl-name">${esc(p.name)}</div><div class="bl-block">${esc(p.senderLines.join("\n"))}</div>`;
  const recipient = `<div class="bl-block">${esc(p.recipientLines.join("\n"))}</div>`;
  const date = dateLine(p.lang, p.senderLines);
  const fr = p.lang === "fr";
  const sign = `<div class="bl-sign${fr ? " bl-right" : ""}">${
    p.signatureUrl ? `<img src="${esc(p.signatureUrl)}" alt="">` : `<div class="bl-blank"></div>`
  }<div>${esc(p.name)}</div></div>`;
  const subject = p.subject ? `<div class="bl-subject">${fr ? "Objet : " : ""}${esc(p.subject)}</div>` : "";

  const head = fr
    ? `${sender}<div class="bl-gap"></div><div class="bl-half">${recipient}</div><div class="bl-gap"></div><div class="bl-right">${esc(date)}</div><div class="bl-gap"></div>`
    : `<div class="bl-right">${sender}<div class="bl-gap"></div>${esc(date)}</div><div class="bl-gap"></div>${recipient}<div class="bl-gap"></div>`;
  return `<div class="bl-content">${head}${subject}${paragraphs}${sign}</div>`;
}

const CONTENT_HEIGHT_MM = PAGE.heightMm - 2 * PAGE.marginYMm;

/**
 * The largest text size (12 pt down to 10.5 pt) at which the letter fits on one page, or null if it doesn't fit
 * even at 10.5 pt. Measured in the browser with the same layout as the PDF.
 */
export function fitLetter(p: LetterParts): number | null {
  if (typeof document === "undefined") return 12;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none";
  host.innerHTML = `<style>${LETTER_CSS}</style><div class="bl-page" lang="${p.lang}">${letterMarkup({ ...p, signatureUrl: undefined })}</div>`;
  document.body.appendChild(host);
  try {
    const page = host.querySelector<HTMLElement>(".bl-page")!;
    const content = host.querySelector<HTMLElement>(".bl-content")!;
    const mm = page.getBoundingClientRect().height / PAGE.heightMm; // px per mm
    for (const pt of SIZES) {
      page.style.fontSize = `${pt}pt`;
      if (content.getBoundingClientRect().height <= CONTENT_HEIGHT_MM * mm) return pt;
    }
    return null;
  } finally {
    host.remove();
  }
}

/** Opens the letter on one A4 page in a print window; the browser's "Save as PDF" makes the file to attach. */
export function printLetter(p: LetterParts, title: string) {
  const pt = fitLetter(p) ?? SIZES[SIZES.length - 1];
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!doctype html><html lang="${p.lang}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:A4;margin:0}html,body{margin:0;background:#fff}${LETTER_CSS}.bl-page{font-size:${pt}pt}</style></head>
<body><div class="bl-page" lang="${p.lang}">${letterMarkup(p)}</div>
<script>
  // Print once the signature image has loaded (or failed), so it is on the PDF.
  const img = document.querySelector(".bl-sign img");
  const go = () => setTimeout(() => { window.focus(); window.print(); }, 150);
  if (!img || img.complete) go(); else { img.onload = go; img.onerror = go; }
</script></body></html>`);
  w.document.close();
}
