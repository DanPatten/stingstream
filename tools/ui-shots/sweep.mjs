// WP-TOOLS UI iterate loop: per-page findings. See docs/UI-LOOP.md.
//
// A "sweep" watches one Playwright page from before navigation to after it settles, and returns a
// flat array of findings ({screen, viewport, kind, severity, detail}). shots.mjs calls
// watchPage(page, ...) right after opening a fresh context/page and BEFORE navigating (console and
// response listeners have to be attached before the navigation they are meant to observe), then
// calls sweepDom(page, ...) once the screen under test has settled, and finally disposes the
// watcher. report.mjs turns the accumulated findings into report.json / report.md.
//
// What "Acceptance" (the plan's Part 2) asks for, checked here: console errors/warnings, failed
// requests, page/element overflow, raw i18n keys, brand words, tap targets < 40px at 390, text
// < 12px, broken images, and a coarse Home-structure check at 1440. The Home-structure check is
// necessarily a heuristic (hero + rows of posters, not a fixed selector) until WP1/WP4 land the
// testID contract in docs/UI-LOOP.md -- it is marked "heuristic" in every finding it produces so a
// reviewer knows to eyeball the screenshot rather than trust it blindly, the same spirit as the
// plan's own "optional axe pass, informational."

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRAND_WORDS = /\b(jellyfin|streamyfin|jellyseerr|radarr|sonarr|nzbget|emby)\b/i;
const I18N_KEY_SHAPE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

function loadAllowlist(allowlistPath) {
  const p = allowlistPath || path.join(__dirname, "allowlist.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      console: (raw.console || []).map((s) => new RegExp(s, "i")),
      responses: (raw.responses || []).map((s) => new RegExp(s, "i")),
    };
  } catch {
    return { console: [], responses: [] };
  }
}

/** Flatten en.json ({a: {b: "x"}}) into a Set of every leaf STRING VALUE (not the key path) --
 * a raw i18n key finding is the app failing to translate at all and rendering the key's own
 * *value* would be correct; rendering the dotted key path itself, or literally one of en.json's
 * other values verbatim where a different string was expected, are both real bugs the reviewer
 * would otherwise have to spot by eye. We only need the *paths* (the "^[a-z0-9_]+(\.[a-z0-9_]+)+$"
 * regex already catches the shape) -- so this returns the set of paths, for the second check
 * ("or any en.json key verbatim").
 */
export function flattenKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenKeys(v, key));
    } else {
      out.push(key);
    }
  }
  return out;
}

/**
 * Attach console/response/pageerror listeners. Call BEFORE navigating. Returns
 * { findings, dispose }: `findings` accumulates as the page runs; call dispose() once done with
 * this page (removes the listeners; does not clear findings already recorded).
 */
export function watchPage(page, { screen, viewport, allowlistPath } = {}) {
  // `screen` may be a plain string (one screen for this page's whole life) or a `() => string`
  // thunk -- shots.mjs keeps ONE page per viewport and walks every screen through it in order (so
  // a screen that depends on a prior click, e.g. Details after Home, actually works), and updates
  // the thunk's return value as it moves from screen to screen so a finding lands on the right one.
  const currentScreen = () => (typeof screen === "function" ? screen() : screen);
  const allow = loadAllowlist(allowlistPath);
  const findings = [];

  const onConsole = (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const text = msg.text();
    if (allow.console.some((re) => re.test(text))) return;
    findings.push({ screen: currentScreen(), viewport, kind: "console", severity: type, detail: text.slice(0, 500) });
  };
  const onPageError = (err) => {
    findings.push({ screen: currentScreen(), viewport, kind: "pageerror", severity: "error", detail: String(err && err.message ? err.message : err).slice(0, 500) });
  };
  const onResponse = (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const url = resp.url();
    if (allow.responses.some((re) => re.test(url))) return;
    findings.push({ screen: currentScreen(), viewport, kind: "response", severity: "error", detail: `${status} ${url}` });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);

  return {
    findings,
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
    },
  };
}

/**
 * DOM-level checks against the page as it currently sits (call after the screen has settled --
 * network idle, or whatever the screen's own flow waits for). `viewportWidth`/`isMobile` steer the
 * viewport-specific checks (tap targets only apply at the 390 mobile viewport).
 */
export async function sweepDom(page, { screen, viewport, viewportWidth, isMobile, i18nKeys = [], checkHomeStructure = false } = {}) {
  const findings = [];

  const result = await page.evaluate(
    ({ i18nKeys, isMobile, brandWordsSource }) => {
      const brandWords = new RegExp(brandWordsSource, "i");
      const i18nKeyShape = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
      const out = {
        pageOverflow: false,
        elementOverflow: [],
        rawI18nKeys: [],
        brandWordHits: [],
        smallTapTargets: [],
        smallText: [],
        brokenImages: [],
        home: null,
      };

      const docEl = document.documentElement;
      out.pageOverflow = docEl.scrollWidth > window.innerWidth + 1;

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
      };

      const hasDirectText = (el) => {
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) return true;
        }
        return false;
      };

      // F-36 (pass-02 critique): WP-GATE's injected `<script>window.__STINGSTREAM_NODE__={...
      // "jellyfin":"/jellyfin" ...}</script>` marker has a text-node child (its own source code) --
      // `hasDirectText` sees that exactly like any other element's text, so without this exclusion
      // the brand-word and i18n-key checks below flag the marker's "jellyfin" *path value* as if it
      // were visible copy. `<meta name="stingstream-node">` is included too per the critique, even
      // though a <meta> has no text-node children today (its brand-relevant data lives in an
      // attribute, not text) -- excluded outright so a future change to what it carries can't
      // resurface this. `style`/`noscript`/`title` are the same class of "has text, never rendered
      // as copy" element and are excluded for the same reason, not just for this one marker.
      const IGNORED_SELECTOR = 'script, style, noscript, title, meta[name="stingstream-node"]';
      const all = Array.from(document.querySelectorAll("*")).filter((el) => !el.matches(IGNORED_SELECTOR));

      // Per-element overflow: an element whose own content is wider than its box, on an element
      // that actually carries text (a wrapper with an overflowing child is that child's finding,
      // not the wrapper's).
      for (const el of all) {
        if (!hasDirectText(el)) continue;
        if (!isVisible(el)) continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          out.elementOverflow.push({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().slice(0, 80),
          });
        }
      }

      // Raw i18n keys and brand words, over every element's OWN direct text (avoids reporting the
      // same string once per ancestor), title, alt and aria-label.
      const textCarriers = all.filter(hasDirectText);
      for (const el of textCarriers) {
        const text = (el.textContent || "").trim();
        if (!text) continue;
        if (i18nKeyShape.test(text) || i18nKeys.includes(text)) {
          out.rawI18nKeys.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 120) });
        }
        if (brandWords.test(text)) {
          out.brandWordHits.push({ where: "text", tag: el.tagName.toLowerCase(), text: text.slice(0, 120) });
        }
      }
      if (brandWords.test(document.title)) {
        out.brandWordHits.push({ where: "title", text: document.title });
      }
      for (const img of Array.from(document.querySelectorAll("img[alt]"))) {
        const alt = img.getAttribute("alt") || "";
        if (brandWords.test(alt)) out.brandWordHits.push({ where: "img[alt]", text: alt });
      }
      for (const el of Array.from(document.querySelectorAll("[aria-label]"))) {
        const label = el.getAttribute("aria-label") || "";
        if (brandWords.test(label)) out.brandWordHits.push({ where: "aria-label", text: label });
      }

      // Tap targets, mobile viewport only.
      if (isMobile) {
        for (const el of Array.from(document.querySelectorAll('button, a, [role="button"]'))) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) {
            out.smallTapTargets.push({
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || "").trim().slice(0, 60),
              width: Math.round(r.width),
              height: Math.round(r.height),
            });
          }
        }
      }

      // Text smaller than 12px, on elements that carry visible text directly.
      for (const el of textCarriers) {
        if (!isVisible(el)) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size && size < 12) {
          out.smallText.push({ tag: el.tagName.toLowerCase(), fontSize: size, text: (el.textContent || "").trim().slice(0, 60) });
        }
      }

      // Broken images: fully loaded, reports zero natural width.
      for (const img of Array.from(document.querySelectorAll("img"))) {
        if (img.complete && img.naturalWidth === 0) {
          out.brokenImages.push({ src: img.currentSrc || img.src, alt: img.getAttribute("alt") || "" });
        }
      }

      return out;
    },
    { i18nKeys, isMobile: !!isMobile, brandWordsSource: BRAND_WORDS.source },
  );

  if (result.pageOverflow) {
    findings.push({ screen, viewport, kind: "overflow-page", severity: "error", detail: `scrollWidth > innerWidth at ${viewportWidth}px` });
  }
  for (const e of result.elementOverflow) {
    findings.push({ screen, viewport, kind: "overflow-element", severity: "error", detail: `<${e.tag}> "${e.text}"` });
  }
  for (const e of result.rawI18nKeys) {
    findings.push({ screen, viewport, kind: "i18n-key", severity: "error", detail: `<${e.tag}> "${e.text}"` });
  }
  for (const e of result.brandWordHits) {
    findings.push({ screen, viewport, kind: "brand-word", severity: "error", detail: `${e.where}: "${e.text}"` });
  }
  for (const e of result.smallTapTargets) {
    findings.push({ screen, viewport, kind: "tap-target", severity: "warning", detail: `<${e.tag}> "${e.text}" ${e.width}x${e.height}px` });
  }
  for (const e of result.smallText) {
    findings.push({ screen, viewport, kind: "small-text", severity: "warning", detail: `<${e.tag}> ${e.fontSize}px "${e.text}"` });
  }
  for (const e of result.brokenImages) {
    findings.push({ screen, viewport, kind: "broken-image", severity: "error", detail: `${e.src} alt="${e.alt}"` });
  }

  if (checkHomeStructure) {
    const home = await page.evaluate(() => {
      // Heuristic, not a fixed selector: a "hero" is a large element (>= 40% of the viewport
      // width, >= 200px tall) sitting in the top 700px; a "row" is a horizontally-scrollable
      // container (scrollWidth > clientWidth) holding >= 4 loaded <img>s. Real once WP1/WP4/WP2
      // land the testID contract (home-hero, home-row) in docs/UI-LOOP.md -- until then this is
      // informational, the same spirit as the plan's own optional axe pass.
      const vw = window.innerWidth;
      let hero = false;
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.top < 700 && r.width >= vw * 0.4 && r.height >= 200) { hero = true; break; }
      }
      let rows = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        const imgs = el.querySelectorAll("img");
        let loaded = 0;
        for (const img of imgs) { if (img.complete && img.naturalWidth > 0) loaded++; }
        if (loaded >= 4) rows++;
      }
      return { hero, rows };
    });
    if (!home.hero) {
      findings.push({ screen, viewport, kind: "home-structure", severity: "warning", detail: "heuristic: no hero-sized element found in the top 700px" });
    }
    if (home.rows < 2) {
      findings.push({ screen, viewport, kind: "home-structure", severity: "warning", detail: `heuristic: found ${home.rows} row(s) with >= 4 loaded posters; wanted >= 2` });
    }
  }

  return findings;
}

export { BRAND_WORDS, I18N_KEY_SHAPE };
