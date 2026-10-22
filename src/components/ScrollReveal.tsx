"use client";

import { useEffect } from "react";

// The blocks of a page (cards and sections) rise into place the first time they come into view, one after
// the other when several appear together. Each block animates once: React keeps the same elements when it
// re-renders, so live updates don't replay it; a new page or newly loaded offers do. Nothing moves for users
// who ask for reduced motion. Marks are data attributes, which React leaves alone, and are removed once the
// block has arrived, so hover effects of the block keep their own transitions.
const BLOCKS = "section, .rounded-xl, .rounded-2xl, .rounded-3xl";
const CONTROLS = "button, a, input, textarea, select, label, span, summary";

export function ScrollReveal({ root }: { root: React.RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const host = root.current;
    if (!host || !("IntersectionObserver" in window)) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const seen = new WeakSet<Element>();
    let batch = 0; // blocks arriving together are staggered
    let batchTimer: number | undefined;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          io.unobserve(el);
          el.style.setProperty("--reveal-delay", `${Math.min(batch, 6) * 70}ms`);
          batch += 1;
          window.clearTimeout(batchTimer);
          batchTimer = window.setTimeout(() => (batch = 0), 120);
          el.dataset.reveal = "in";
          window.setTimeout(() => {
            delete el.dataset.reveal;
            el.style.removeProperty("--reveal-delay");
          }, 1100);
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -4% 0px" },
    );

    // Only the outermost blocks animate (a card inside a card moves with its parent).
    const scan = () => {
      for (const el of host.querySelectorAll(BLOCKS)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.matches(CONTROLS)) continue; // a rounded button or field is not a block
        const outer = el.parentElement?.closest(BLOCKS);
        if (outer && host.contains(outer)) continue;
        (el as HTMLElement).dataset.reveal = "wait";
        io.observe(el);
      }
    };
    scan();
    let pending = 0;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        scan();
      });
    });
    mo.observe(host, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      io.disconnect();
      cancelAnimationFrame(pending);
      window.clearTimeout(batchTimer);
      // Never leave a block hidden.
      for (const el of host.querySelectorAll("[data-reveal]")) delete (el as HTMLElement).dataset.reveal;
    };
  }, [root]);
  return null;
}
