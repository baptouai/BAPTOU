// Light or dark: the visitor's choice (kept in this browser), otherwise the device's setting, followed live.
// Loaded in <head> so the theme is set before the first paint; adds the switch at the top left of the header.
(function () {
  // The old Firebase addresses forward to the site's own domain.
  if (/^baptou-5041c\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) {
    location.replace("https://baptou.com" + location.pathname + location.search + location.hash);
    return;
  }
  // English at /, French at /fr. A browser set to French lands on /fr, unless the visitor picked English with
  // the EN / FR switch (remembered as "lang"). The page they came from is passed on for the visit counter.
  try {
    var lang = localStorage.getItem("lang");
    var french = lang === "fr" || (!lang && /^fr\b/i.test(navigator.language || ""));
    if (french && (location.pathname === "/" || location.pathname === "/index.html")) {
      sessionStorage.setItem("ref", document.referrer);
      location.replace("/fr" + location.search + location.hash);
      return;
    }
  } catch (e) {}
  // Visit counter, without cookies: the page and the address the visitor came from, read in BAPTOU Admin
  // (functions/src/siteStats.ts). Opening baptou.com/?notrack once stops counting this browser.
  // New visitors: the first visit leaves a "seen" date in this browser (no identifier), so later visits count as
  // returning. Set once, never renewed, and ignored after 13 months (the CNIL's limit for audience measurement).
  try {
    var ref = sessionStorage.getItem("ref"); // set just before the move from / to /fr
    if (ref !== null) sessionStorage.removeItem("ref");
    if (/[?&]notrack\b/.test(location.search)) localStorage.setItem("notrack", "1");
    if (localStorage.getItem("notrack") !== "1" && /(^|\.)baptou\.com$/.test(location.hostname) && navigator.sendBeacon) {
      var fresh = Date.now() - (Number(localStorage.getItem("seen")) || 0) > 395 * 86400000;
      if (fresh) localStorage.setItem("seen", String(Date.now()));
      var from = ref !== null ? ref : document.referrer;
      // w: this page reports its time on screen (below), so the averages only divide by visits that can.
      navigator.sendBeacon("/api/hit", new Blob([JSON.stringify({ p: location.pathname, r: from, n: fresh ? 1 : 0, w: 1 })], { type: "text/plain" }));
      // Time on the site: only while the page is on screen, sent (in seconds) each time it is hidden: another tab
      // or app, or closed. A visit that started as a new person keeps that mark for its next pages in this tab
      // (sessionStorage "newVisit", 1 or 0, no identifier), so BAPTOU Admin can show the time per new person.
      if (!/^https?:\/\/([^\/]*\.)?baptou\.com(\/|$)/.test(from || "")) sessionStorage.setItem("newVisit", fresh ? "1" : "0");
      var isNew = sessionStorage.getItem("newVisit") === "1";
      var shownAt = document.visibilityState === "visible" ? Date.now() : 0;
      var sendTime = function () {
        if (!shownAt) return;
        var s = Math.min(Math.round((Date.now() - shownAt) / 1000), 1800); // a forgotten tab counts 30 min at most
        shownAt = 0;
        if (s >= 1) navigator.sendBeacon("/api/hit", new Blob([JSON.stringify({ t: s, v: isNew ? 1 : 0 })], { type: "text/plain" }));
      };
      var resume = function () {
        if (document.visibilityState === "visible" && !shownAt) shownAt = Date.now();
      };
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") sendTime();
        else resume();
      });
      window.addEventListener("pagehide", sendTime);
      window.addEventListener("pageshow", resume); // back to this page from the browser's cache
    }
  } catch (e) {}

  var KEY = "theme";
  var root = document.documentElement;
  // Lets the stylesheet hide what will rise into view (without JavaScript, everything simply shows).
  root.classList.add("js");
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function stored() {
    try {
      var t = localStorage.getItem(KEY);
      return t === "light" || t === "dark" ? t : null;
    } catch (e) {
      return null;
    }
  }
  function apply(t) {
    root.setAttribute("data-theme", t);
    var b = document.querySelector(".theme-switch");
    if (b) {
      b.setAttribute("aria-checked", String(t === "dark"));
      b.title = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
  }
  apply(stored() || (mq.matches ? "dark" : "light"));
  mq.addEventListener("change", function () {
    if (!stored()) apply(mq.matches ? "dark" : "light");
  });
  document.addEventListener("DOMContentLoaded", function () {
    var header = document.querySelector("header");
    if (!header) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "theme-switch";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-label", "Dark mode");
    b.innerHTML =
      '<span class="knob">' +
      '<svg class="sun" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
      '<svg class="moon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>' +
      "</span>";
    b.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
      apply(next);
    });
    var host = header.querySelector(".bar") || header;
    host.insertBefore(b, host.firstChild);
    apply(root.getAttribute("data-theme") || "light");
    // The EN / FR switch: the choice wins over the browser's language from now on.
    Array.prototype.forEach.call(document.querySelectorAll(".lang-switch a[data-lang]"), function (a) {
      a.addEventListener("click", function () {
        try {
          localStorage.setItem("lang", a.getAttribute("data-lang"));
        } catch (e) {}
      });
    });
  });

  // Scroll animations: .reveal elements (and the children of [data-stagger], one after the other) rise into
  // place when they come into view; the top bar gets a background once the page scrolls; the hero's cards
  // drift a little slower than the page. Nothing moves for visitors who ask for reduced motion.
  document.addEventListener("DOMContentLoaded", function () {
    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    Array.prototype.forEach.call(document.querySelectorAll("[data-stagger]"), function (list) {
      Array.prototype.forEach.call(list.children, function (item, i) {
        item.classList.add("reveal");
        item.style.setProperty("--d", i * 90 + "ms");
      });
    });
    var targets = document.querySelectorAll(".reveal, .hero-visual");
    if (still || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(targets, function (el) { el.classList.add("in"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
      Array.prototype.forEach.call(targets, function (el) { io.observe(el); });
    }
    var bar = document.querySelector(".topbar");
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (bar) bar.classList.toggle("scrolled", window.scrollY > 8);
        if (!still) root.style.setProperty("--sy", String(Math.min(window.scrollY, 1200)));
      });
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  });
})();
