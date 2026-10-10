// Light or dark: the visitor's choice (kept in this browser), otherwise the device's setting, followed live.
// Loaded in <head> so the theme is set before the first paint; adds the switch at the top left of the header.
(function () {
  // The old Firebase addresses forward to the site's own domain.
  if (/^baptou-5041c\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) {
    location.replace("https://baptou.com" + location.pathname + location.search + location.hash);
    return;
  }
  var KEY = "theme";
  var root = document.documentElement;
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
    header.insertBefore(b, header.firstChild);
    apply(root.getAttribute("data-theme") || "light");
  });
})();
