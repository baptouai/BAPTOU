import puppeteer, { type Browser, type ElementHandle, type Frame, type Page } from "puppeteer-core";

// A headless Chrome on the server, driven step by step (see unlock.ts). Pages are seen as plain text plus
// a numbered list of the elements one can act on; acting goes through a few narrow methods.

// Places the browser must never reach: the server's own metadata service and private networks.
const BLOCKED_HOST =
  /^(localhost|metadata|metadata\.google\.internal|.+\.internal)$|^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^\[?(::1|f[cd][0-9a-f]{2}:)/i;

// Buttons that would send an application. BAPTOU never clicks them.
export const SUBMIT_LIKE =
  /\bsubmit\b|soumettre|send (my |your |the )?application|envoyer (ma |la |votre )?candidature|finali[sz]e|terminer (ma |la )?candidature|complete (my |your )?application|valider (ma |la )?candidature/i;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PageElement = { id: string; kind: string; label: string };
export type Snapshot = {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  captcha: boolean; // a "verify you are human" check is on the page
  password: boolean; // a password field is on the page
};

export class BrowserSession {
  private constructor(
    private browser: Browser,
    private page: Page,
  ) {}

  /** Opens `url` in a fresh browser. `executablePath` and `args` come from @sparticuz/chromium in the cloud. */
  static async open(url: string, launch: { executablePath: string; args?: string[] }) {
    const browser = await puppeteer.launch({ ...launch, headless: true, defaultViewport: { width: 1280, height: 900 } });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en,fr;q=0.8" });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      let host = "";
      let protocol = "";
      try {
        ({ hostname: host, protocol } = new URL(req.url()));
      } catch {
        return req.abort();
      }
      const allowedScheme = protocol === "https:" || protocol === "http:" || protocol === "data:" || protocol === "blob:";
      if (!allowedScheme || BLOCKED_HOST.test(host)) return req.abort();
      // Pictures, videos and fonts aren't needed to read a page.
      if (["image", "media", "font"].includes(req.resourceType())) return req.abort();
      return req.continue();
    });
    const session = new BrowserSession(browser, page);
    await session.goto(url);
    return session;
  }

  async goto(url: string) {
    const { hostname, protocol } = new URL(url);
    if ((protocol !== "https:" && protocol !== "http:") || BLOCKED_HOST.test(hostname)) throw new Error("This address can't be opened.");
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.settle();
  }

  /** Waits for the page to finish what a click or a navigation started. */
  private async settle() {
    await Promise.race([this.page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {}), sleep(8000)]);
    await sleep(500);
  }

  /** What's on the page: its text and the elements one can act on, numbered across all frames. */
  async look(): Promise<Snapshot> {
    const frames = this.page.frames();
    const parts = await Promise.all(
      frames.map((frame, fi) =>
        frame
          .evaluate((prefix: string) => {
            const visible = (el: Element) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
            };
            const labelOf = (el: HTMLElement) => {
              const id = el.getAttribute("id");
              const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
              return (
                el.getAttribute("aria-label") ||
                forLabel ||
                el.closest("label")?.textContent ||
                (el as HTMLInputElement).placeholder ||
                el.innerText ||
                (el as HTMLInputElement).value ||
                el.getAttribute("name") ||
                el.getAttribute("title") ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80);
            };
            const nodes = [
              ...document.querySelectorAll<HTMLElement>(
                "input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=link], [role=checkbox]",
              ),
            ].filter(visible);
            const elements = nodes.slice(0, 80).map((el, i) => {
              const id = `${prefix}${i}`;
              el.setAttribute("data-baptou", id);
              const tag = el.tagName.toLowerCase();
              const kind = tag === "input" ? `input:${(el as HTMLInputElement).type || "text"}` : tag === "a" ? "link" : el.getAttribute("role") ?? tag;
              return { id, kind, label: labelOf(el) };
            });
            const html = document.documentElement.innerHTML;
            return {
              text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 3000),
              elements,
              captcha:
                /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|data-sitekey|captcha/i.test(html) ||
                /verify (that )?you are (a )?human|prove you're not a robot|je ne suis pas un robot/i.test(document.body?.innerText ?? ""),
              password: nodes.some((el) => el.tagName === "INPUT" && (el as HTMLInputElement).type === "password"),
            };
          }, `f${fi}-`)
          .catch(() => null),
      ),
    );
    const ok = parts.filter((p): p is NonNullable<typeof p> => !!p);
    return {
      url: this.page.url(),
      title: await this.page.title(),
      text: ok
        .map((p) => p.text)
        .filter(Boolean)
        .join("\n---\n")
        .slice(0, 4000),
      elements: ok.flatMap((p) => p.elements),
      captcha: ok.some((p) => p.captcha),
      password: ok.some((p) => p.password),
    };
  }

  private async find(id: string): Promise<{ frame: Frame; el: ElementHandle<Element> }> {
    const fi = Number(/^f(\d+)-\d+$/.exec(id)?.[1]);
    const frame = this.page.frames()[fi];
    const el = frame ? ((await frame.$(`[data-baptou="${id}"]`)) as ElementHandle<Element> | null) : null;
    if (!frame || !el) throw new Error(`Element ${id} isn't on the page any more. Look again.`);
    return { frame, el };
  }

  /** Clicks an element, unless it would send the application. */
  async click(id: string) {
    const { el } = await this.find(id);
    const label = await el.evaluate((n) =>
      [(n as HTMLElement).innerText, n.getAttribute("aria-label"), (n as HTMLInputElement).value].filter(Boolean).join(" "),
    );
    if (SUBMIT_LIKE.test(label)) throw new Error("BAPTOU never clicks a button that sends the application.");
    await el.click();
    await this.settle();
  }

  /** Types into a text field, replacing what was there. */
  async type(id: string, value: string) {
    const { el } = await this.find(id);
    const kind = await el.evaluate((n) => (n.tagName === "INPUT" ? (n as HTMLInputElement).type : n.tagName.toLowerCase()));
    if (kind === "password") throw new Error("BAPTOU never types into a password field.");
    await el.click({ count: 3 });
    await el.type(value, { delay: 25 });
  }

  /** The text of the whole page, every frame, for reading the form. */
  async fullText() {
    const texts = await Promise.all(
      this.page.frames().map((f) => f.evaluate(() => document.body?.innerText ?? "").catch(() => "")),
    );
    return texts.filter(Boolean).join("\n\n").slice(0, 40_000);
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}
