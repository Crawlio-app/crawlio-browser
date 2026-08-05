// selector-kernel.ts — the @crawlio/selectors kernel, made injectable + a few
// server-side wrappers.
//
// M3 doctrine: the extension has a LIVE browser (CDP), so the DOM-dependent
// kernel runs IN THE PAGE — not reimplemented here, but the kernel's OWN
// compiled source (computeXPath, resolvesExactlyTo, the array-xpath
// generalizer, the element registry) read from `@crawlio/selectors/dist`,
// stripped of ES-module syntax, and wrapped with a 5-rail forge into one
// injectable prelude. Consumers (`tools.ts` detect_tables, `robot-training.ts`
// monitor, `pickerOverlay.ts`) concatenate `getForgePreludeJs()` ahead of their
// own page program; once it runs the page exposes:
//   window.__crawlioSelectors  — the kernel primitives
//   window.__crawlioForge      — { bundle(el) -> ForgedSelectorBundle }
//
// The forge proposes five rails for an element and VERIFIES each directly-
// resolvable one with the kernel oracle (`resolvesExactlyTo`) before trusting
// it. The two text-shaped rails (textContent, rolePlusText) are heal hints used
// at replay time by `selectWorkingRail`.
//
// Everything DOM-free (array-xpath generalization, the rail ladder) stays here
// in Node so the server can reason about selectors without a browser.

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generalizeArrayXpath } from "@crawlio/selectors";

// --- Types -------------------------------------------------------------------

/** The five canonical rails, in heal-priority order (most semantic first). A
 *  recording made brittle by a positional xpath heals down this ladder. */
export const RAIL_LADDER = [
  "rolePlusText",
  "textContent",
  "attribute",
  "classChain",
  "xpath",
] as const;

export type RailName = (typeof RAIL_LADDER)[number];

/** The directly-resolvable primary the forge trusts (verified by the oracle). */
export interface ForgedSelector {
  type: "css" | "xpath";
  value: string;
  rail: RailName;
}

/** All five rails for a forged element. `xpath`/`attribute`/`classChain` are
 *  verified, directly-resolvable selectors (or null); `textContent`/
 *  `rolePlusText` are heal hints. */
export interface ForgedRails {
  xpath: string | null;
  attribute: string | null;
  classChain: string | null;
  textContent: string | null;
  rolePlusText: string | null;
}

/** What `window.__crawlioForge.bundle(el)` returns for one element. */
export interface ForgedSelectorBundle {
  verified: boolean;
  selector: ForgedSelector | null;
  rails: ForgedRails;
}

// --- Server-side (DOM-free) helpers ------------------------------------------

/**
 * Generalize per-element structural xpaths into one index-stripped array xpath,
 * server-side. Drops blank/missing picks and requires >= 2 valid xpaths before
 * trusting a generalization (one pick can't define an array). Returns null when
 * the picks don't form a clean array.
 */
export function generalizeVerifiedArrayXpath(
  xpaths: Array<string | null | undefined>,
): string | null {
  const valid = xpaths.filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  if (valid.length < 2) return null;
  return generalizeArrayXpath(valid);
}

/**
 * Deterministic replay heal: pick the rail that still resolves. Tries the
 * recorded primary first (cheapest — usually it still works), then walks the
 * rail ladder. `resolves(rail, value)` reports whether a rail's value still
 * matches its element in the live page. Returns the working rail or null when
 * the whole bundle has drifted.
 */
export function selectWorkingRail(
  bundle: ForgedSelectorBundle,
  resolves: (rail: string, value: string) => boolean,
): { rail: string; value: string } | null {
  const primary = bundle.selector;
  if (primary && primary.value && resolves(primary.rail, primary.value)) {
    return { rail: primary.rail, value: primary.value };
  }
  for (const rail of RAIL_LADDER) {
    const value = bundle.rails[rail];
    if (value && resolves(rail, value)) {
      return { rail, value };
    }
  }
  return null;
}

// --- The injectable prelude (the kernel's own source + the forge) ------------

// The kernel dist modules concatenated into the prelude, in dependency order
// (arrayXpath before predictListItems, which consumes it). `contract.js`
// (needs zod) and `inspectionView.js` are deliberately excluded — the forge
// needs only xpath synthesis, the array generalizer, and the verify oracle.
const KERNEL_MODULES = [
  "xpath.js",
  "arrayXpath.js",
  "elementRegistry.js",
  "predictListItems.js",
] as const;

/** Strip ES-module syntax so the kernel source can run as plain statements
 *  inside an IIFE (no import/export, no sourcemap comment). */
function stripModuleSyntax(src: string): string {
  return src
    .replace(/^\s*import\s[^\n]*?;\s*$/gm, "") // drop ESM imports (resolved by concat order)
    .replace(/^export\s+/gm, "") // `export function|class|const X` -> bare statement
    .replace(/^\/\/#\s*sourceMappingURL=.*$/gm, ""); // drop sourcemap reference
}

// The 5-rail forge, injected after the kernel source. Pure page JS (String.raw
// so regex backslashes survive verbatim; no `${}`/backticks inside). It calls
// the kernel's computeXPath + resolvesExactlyTo defined just above it.
const FORGE_BODY = String.raw`
  function __cf_verify(sel, el) {
    try { return resolvesExactlyTo(sel, [el], el.ownerDocument || document); }
    catch (e) { return false; }
  }
  function __cf_cssEscape(s) {
    try { if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s); } catch (e) {}
    return String(s).replace(/[^\w-]/g, function (c) { return '\\' + c; });
  }
  function __cf_attrCss(tag, attr, value) {
    var v = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (attr === 'id') return '#' + __cf_cssEscape(value);
    if (attr === 'name') return tag + '[name="' + v + '"]';
    return '[' + attr + '="' + v + '"]';
  }
  // Rail 1: xpath (structural). Prefer a stable test-attribute anchor, fall
  // back to the full structural path. Verified before trust.
  function __cf_xpath(el) {
    var attrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
    try {
      var anchored = computeXPath(el, true, attrs);
      if (anchored && __cf_verify({ type: 'xpath', value: anchored }, el)) return anchored;
    } catch (e) {}
    try {
      var structural = computeXPath(el);
      if (structural && __cf_verify({ type: 'xpath', value: structural }, el)) return structural;
    } catch (e) {}
    return null;
  }
  // Rail 2: attribute (stable id/test/name) -> CSS. Verified.
  function __cf_attribute(el) {
    if (!el.getAttribute) return null;
    var tag = (el.tagName || '').toLowerCase();
    var attrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'id', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      try {
        var v = el.getAttribute(attrs[i]);
        if (!v) continue;
        var css = __cf_attrCss(tag, attrs[i], v);
        if (__cf_verify({ type: 'css', value: css }, el)) return css;
      } catch (e) {}
    }
    return null;
  }
  // Rail 3: classChain -> tag.classA.classB (digit-bearing classes dropped as
  // likely-generated). Verified.
  function __cf_classChain(el) {
    try {
      var tag = (el.tagName || '').toLowerCase();
      if (!tag) return null;
      var raw = (el.className && el.className.toString) ? el.className.toString() : '';
      var classes = raw.trim().split(/\s+/).filter(function (c) {
        return c && !/\d/.test(c);
      }).slice(0, 3);
      if (!classes.length) return null;
      var css = tag + '.' + classes.map(__cf_cssEscape).join('.');
      if (__cf_verify({ type: 'css', value: css }, el)) return css;
    } catch (e) {}
    return null;
  }
  // Rail 4: textContent — heal hint (trimmed visible text).
  function __cf_text(el) {
    try {
      var t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
      return t ? t.slice(0, 80) : null;
    } catch (e) { return null; }
  }
  function __cf_implicitRole(el) {
    var t = (el.tagName || '').toLowerCase();
    if (t === 'a' && el.getAttribute && el.getAttribute('href')) return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') {
      var ty = ((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
      if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      return 'textbox';
    }
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    return null;
  }
  // Rail 5: rolePlusText — "role[text]" heal hint (ARIA/implicit role + name).
  function __cf_roleText(el) {
    try {
      var role = (el.getAttribute && el.getAttribute('role')) || __cf_implicitRole(el);
      var txt = (el.getAttribute && el.getAttribute('aria-label')) || __cf_text(el);
      if (!role || !txt) return null;
      return role + '[' + txt + ']';
    } catch (e) { return null; }
  }
  function __crawlioBundle(el) {
    if (!el || el.nodeType !== 1) return null;
    var rails = {
      xpath: __cf_xpath(el),
      attribute: __cf_attribute(el),
      classChain: __cf_classChain(el),
      textContent: __cf_text(el),
      rolePlusText: __cf_roleText(el),
    };
    // Primary = the most robust VERIFIED directly-resolvable rail: a stable
    // attribute beats a structural xpath beats a class chain. text/role rails
    // are heal-only hints and never become the primary.
    var order = [['attribute', 'css'], ['xpath', 'xpath'], ['classChain', 'css']];
    var selector = null;
    for (var i = 0; i < order.length; i++) {
      var name = order[i][0];
      var value = rails[name];
      if (value) { selector = { type: order[i][1], value: value, rail: name }; break; }
    }
    return { verified: !!selector, selector: selector, rails: rails };
  }
`;

let cachedPrelude: string | null = null;
let cachedAvailable: boolean | null = null;

// Locate `@crawlio/selectors/dist` by walking up to the nearest node_modules.
// The package's `exports` map only declares an `import` condition, so a CJS
// `require.resolve` fails — and this also tolerates hoisted installs. Works
// from src (vitest) and from the bundled dist alike.
function findKernelDistDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, "node_modules", "@crawlio", "selectors", "dist");
    if (existsSync(join(candidate, "index.js"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("@crawlio/selectors dist not found (kernel source unavailable)");
}

function buildPrelude(): string {
  const distDir = findKernelDistDir();
  const kernelSource = KERNEL_MODULES.map((m) =>
    stripModuleSyntax(readFileSync(join(distDir, m), "utf-8")),
  ).join("\n");

  return [
    "(function(){",
    "  if (typeof globalThis !== 'undefined' && globalThis.__crawlioForge) { return; }",
    kernelSource,
    FORGE_BODY,
    "  var __ns = {",
    "    computeXPath: computeXPath,",
    "    resolvesExactlyTo: resolvesExactlyTo,",
    "    queryAll: queryAll,",
    "    generalizeArrayXpath: generalizeArrayXpath,",
    "    partOfSameArrayXpath: partOfSameArrayXpath,",
    "    predictListMatches: predictListMatches,",
    "    ElementRegistry: ElementRegistry",
    "  };",
    "  var __g = (typeof window !== 'undefined') ? window : globalThis;",
    "  __g.__crawlioSelectors = __ns;",
    "  __g.__crawlioForge = { bundle: __crawlioBundle };",
    "})();",
  ].join("\n");
}

/**
 * The injectable forge prelude: the @crawlio/selectors kernel's OWN compiled
 * source + the 5-rail forge, as a self-installing IIFE that defines
 * `window.__crawlioSelectors` and `window.__crawlioForge`. Concatenate it ahead
 * of any page program that wants verified selectors. Built once and cached.
 */
export function getForgePreludeJs(): string {
  if (cachedPrelude === null) {
    cachedPrelude = buildPrelude();
    cachedAvailable = true;
  }
  return cachedPrelude;
}

/** True iff the kernel source could be loaded into the prelude (it ships with
 *  the package, so this is true in any normal install). */
export function kernelAvailable(): boolean {
  if (cachedAvailable === null) {
    try {
      getForgePreludeJs();
    } catch {
      cachedAvailable = false;
    }
  }
  return cachedAvailable === true;
}
