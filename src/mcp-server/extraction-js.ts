/**
 * Single source for the in-page extraction JavaScript that was previously
 * copy-pasted across the detect_tables / extract_table / extract_data handlers
 * and their smart.* twins in tools.ts.
 *
 * Contract for every generated program:
 * - Starts with a stable sentinel comment (`/*crawlio:detect-tables*` etc.) so
 *   tests and bridge mocks can identify the program without pattern-matching
 *   its body.
 * - All parameters are injected exactly once, as a single trailing JSON literal
 *   applied to an IIFE — `})({"maxRows":200})` — never interpolated through the
 *   body. The one exception is the extract-table selector, which is embedded
 *   as its own IIFE argument via jsLiteral (JSON plus U+2028/U+2029
 *   escaping, which are JS line terminators JSON leaves raw).
 * - Stays under 10,000 chars for any realistic selector: older installed extensions
 *   enforce that cap on browser_evaluate expressions. (A selector made entirely of
 *   line separators exceeds it, since each escapes six-fold — such a selector cannot
 *   occur in real CSS, and an older extension rejects it with a clear length error
 *   rather than mis-parsing it.)
 * - Degrades on huge DOMs (node-count bail-outs) instead of timing out.
 *
 * Selector verification deliberately does NOT use the selector-kernel prelude
 * (getForgePreludeJs, ~17KB) — a compact uniqueness check is enough here: a
 * selector is verified iff it matches exactly one element and that element is
 * the one it was built from.
 */

export interface DetectTablesOptions {
  maxCandidates?: number;
}

export interface ExtractTableOptions {
  maxRows?: number;
}

export interface DetectSectionsOptions {
  maxDepth?: number;
  maxSections?: number;
}

/** Max generated-program size older extensions accept for browser_evaluate. */
export const MAX_EXTRACTION_PROGRAM_CHARS = 10000;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Strip leading indentation from generated lines. Keeps the TS source readable
 * while the emitted program stays comfortably inside the 10K budget even with a
 * worst-case (heavily escaped) 1000-char selector. No emitted string literal
 * spans lines, so this cannot corrupt program content.
 */
function compact(js: string): string {
  return js.replace(/\n[ \t]+/g, "\n");
}

// Shared in-page helpers, single-sourced here. Each builder embeds only the
// helpers its program actually calls — that keeps even the worst case (a
// 1000-char selector that doubles under JSON escaping) inside the 10K budget.
//
// Two hostile-page rules hold throughout the emitted programs:
// - Maps keyed by page-derived strings are prototype-free (Object.create(null)):
//   a header or class literally named "constructor" or a role="__proto__" must
//   not alias inherited Object.prototype members during read-before-write checks.
// - Only XHTML-namespace elements count as rows/sections. Inline SVG keeps a
//   lowercase tagName in HTML documents ('svg', never 'SVG'), so uppercase
//   skip lists can never match it — namespaceURI is the only reliable gate,
//   and it also keeps undefined offsetWidth/offsetHeight (SVGElement has
//   neither) out of score arithmetic.
const HELPER_GET_CLASSES = String.raw`
function getClasses(el) {
  return (el.className || '').toString().trim().split(/\s+/).filter(function(c) { return c && !c.match(/\d/); });
}
`;

const HELPER_MATCHING_CHILDREN = String.raw`
function getMatchingChildren(parent) {
  var children = [].slice.call(parent.children).filter(function(c) {
    return c.namespaceURI === 'http://www.w3.org/1999/xhtml' && ['SCRIPT','IMG','STYLE','NOSCRIPT'].indexOf(c.tagName) < 0 && c.textContent.trim().length > 0;
  });
  if (children.length < 2) return [];
  var freq = Object.create(null);
  children.forEach(function(c) {
    var key = getClasses(c).sort().join(' ');
    freq[key] = (freq[key] || 0) + 1;
  });
  var threshold = children.length / 2 - 2;
  var patterns = Object.keys(freq).filter(function(k) { return k && freq[k] >= threshold; });
  if (!patterns.length) {
    var indiv = Object.create(null);
    children.forEach(function(c) { getClasses(c).forEach(function(cls) { indiv[cls] = (indiv[cls] || 0) + 1; }); });
    patterns = Object.keys(indiv).filter(function(k) { return indiv[k] >= threshold; });
  }
  return children.filter(function(c) {
    var cls = getClasses(c);
    return patterns.some(function(p) { return p.split(' ').every(function(pc) { return !pc || cls.indexOf(pc) >= 0; }); });
  });
}
`;

const HELPER_BUILD_SELECTOR = String.raw`
function buildSelector(el) {
  var parts = [];
  var node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    var tag = node.tagName.toLowerCase();
    if (node.id && !/\d/.test(node.id)) tag += '#' + CSS.escape(node.id);
    else if (node.className && typeof node.className === 'string') {
      var cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) tag += '.' + cls.map(function(c) { return CSS.escape(c); }).join('.');
    }
    parts.unshift(tag);
    node = node.parentElement;
  }
  return parts.join(' > ');
}
`;

const HELPER_DIRECT_TEXT = String.raw`
function directText(el) {
  var text = '';
  for (var i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === 3) text += el.childNodes[i].textContent;
  }
  return text.trim();
}
`;

const HELPER_EXTRACT_ROW = String.raw`
function extractRow(el, prefix) {
  var data = {};
  var tag = el.tagName.toLowerCase();
  var cls = getClasses(el).slice(0, 2).join('.');
  var key = prefix + '/' + (cls ? tag + '.' + cls : tag);
  var dt = directText(el);
  if (dt) data[key] = dt;
  if (el.href) data[key + ' href'] = el.href;
  if (el.src) data[key + ' src'] = el.src;
  for (var i = 0; i < el.children.length; i++) {
    var childData = extractRow(el.children[i], key);
    for (var k in childData) data[k] = childData[k];
  }
  return data;
}
`;

const HELPER_VERIFY_SELECTOR = String.raw`
function verifySelector(sel, el) {
  if (!sel) return false;
  try {
    var m = document.querySelectorAll(sel);
    return m.length === 1 && m[0] === el;
  } catch (e) { return false; }
}
`;

/**
 * The complete shared helper block (all in-page helpers plus the compact
 * uniqueness check that replaces the ~17KB selector-kernel prelude). Builders
 * embed per-program subsets of these same pieces.
 */
export const EXTRACTION_HELPERS_JS =
  HELPER_GET_CLASSES + HELPER_MATCHING_CHILDREN + HELPER_BUILD_SELECTOR +
  HELPER_DIRECT_TEXT + HELPER_EXTRACT_ROW + HELPER_VERIFY_SELECTOR;

/**
 * Table detection. Two strategies:
 * - "table-rows": native <table> fast path — real tables win outright (confidence
 *   ~0.82 baseline, rising slightly with row count so the biggest table ranks first).
 * - "sibling-repeated-blocks": the class-frequency div-soup scan, hardened with
 *   geometric filters (rows within 30% of median height; containers with more
 *   than 300 children skipped as likely-virtualized).
 */
const DETECT_TABLES_BODY = String.raw`
var maxCandidates = opts.maxCandidates;
var CHILD_CAP = 300;
var MAX_SCAN = 30000;
var candidates = [];
function pushCandidate(el, rowCount, sample, confidence, strategy, warnings) {
  var w = el.offsetWidth, h = el.offsetHeight;
  candidates.push({
    selector: buildSelector(el),
    score: w * h * rowCount * rowCount,
    rowCount: rowCount,
    sampleText: sample.substring(0, 200),
    area: w * h,
    confidence: Math.round(confidence * 1000) / 1000,
    strategy: strategy,
    warnings: warnings
  });
}
var tables = document.querySelectorAll('table');
for (var ti = 0; ti < tables.length; ti++) {
  var tbl = tables[ti];
  var trs = tbl.querySelectorAll('tr');
  var headRows = 0, bodyRows = [];
  for (var ri = 0; ri < trs.length; ri++) {
    var tr = trs[ri];
    if (tr.closest('table') !== tbl || tr.cells.length < 2) continue;
    if (tr.closest('thead')) { headRows++; continue; }
    bodyRows.push(tr);
  }
  var hasHeader = headRows > 0 && tbl.querySelectorAll('thead th').length > 0;
  if (!hasHeader && bodyRows.length > 1) {
    var first = bodyRows[0];
    var ths = first.querySelectorAll('th');
    if (ths.length >= 2 && ths.length === first.cells.length) { hasHeader = true; bodyRows.shift(); }
  }
  if (bodyRows.length < 2) continue;
  var warnings = [];
  if (!hasHeader) warnings.push('no header row found');
  if (bodyRows.length > CHILD_CAP) warnings.push('container exceeds child cap');
  var sample = '';
  for (var si = 0; si < bodyRows.length && sample.length < 200; si++) sample += bodyRows[si].textContent.trim() + ' ';
  var conf = Math.min(0.9, 0.82 + Math.min(bodyRows.length, 100) * 0.0005);
  pushCandidate(tbl, bodyRows.length, sample, conf, 'table-rows', warnings);
}
var all = document.querySelectorAll('body *');
var scanTruncated = all.length > MAX_SCAN;
var limit = scanTruncated ? MAX_SCAN : all.length;
for (var i = 0; i < limit; i++) {
  var el = all[i];
  if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || el.closest('table')) continue;
  var w = el.offsetWidth, h = el.offsetHeight;
  if (w < 100 || h < 50) continue;
  if (el.children.length > CHILD_CAP) continue;
  var matching = getMatchingChildren(el);
  if (matching.length < 2) continue;
  var divWarnings = [];
  var heights = matching.map(function(c) { return c.offsetHeight; }).sort(function(a, b) { return a - b; });
  var median = heights[Math.floor(heights.length / 2)];
  var kept = matching;
  if (median > 0) {
    kept = matching.filter(function(c) { var ch = c.offsetHeight; return ch >= median * 0.7 && ch <= median * 1.3; });
    if (kept.length < 2) continue;
    if (kept.length < matching.length) divWarnings.push('row heights inconsistent');
  }
  if (scanTruncated) divWarnings.push('dom scan truncated at ' + MAX_SCAN + ' nodes');
  var cells = 0;
  var leaves = kept[0].querySelectorAll('*');
  for (var li = 0; li < leaves.length && li < 200; li++) {
    if (!leaves[li].firstElementChild && leaves[li].textContent.trim()) cells++;
  }
  cells = Math.max(1, Math.min(cells, 12));
  var text = kept.map(function(c) { return c.textContent.trim(); }).join(' ');
  var conf2 = Math.min(0.78, 0.55 + Math.min(kept.length, 12) * 0.015 + cells * 0.025);
  pushCandidate(el, kept.length, text, conf2, 'sibling-repeated-blocks', divWarnings);
}
candidates.sort(function(a, b) { return (b.confidence - a.confidence) || (b.score - a.score); });
return candidates.slice(0, maxCandidates);
`;

/**
 * Table extraction. Native <table> containers get header-promoted column names
 * (thead th, or an all-th first row) plus <name>_url companions for link-bearing
 * columns. Div-soup containers keep the recursive path-keyed collection but get
 * semantic column names: link-first ordering (anchor text + <name>_url pairs),
 * then content-hinted names (price / source_domain), then class-derived names —
 * with the original path retained on every column for back-compat.
 *
 * Only `used`, `usedName`, and `unique` need Object.create(null): their keys are
 * header/class/cell-derived and can literally be "constructor". The path-keyed
 * maps (seenK, byKey, usedKey, nameOf) stay plain objects — every extractRow key
 * starts with '/', which no Object.prototype member does, and the worst-case
 * program is within ~300 chars of the 10K budget.
 */
const EXTRACT_TABLE_BODY = String.raw`
var maxRows = opts.maxRows;
var empty = { selector: sel, columns: [], rows: [], totalRows: 0, truncated: false };
var container = null;
try { container = document.querySelector(sel); } catch (e) { return empty; }
if (!container) return empty;
if (container.querySelectorAll('*').length > 40000) maxRows = Math.min(maxRows, 50);
function slug(s) {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 40);
}
function cellText(el) { return (el.textContent || '').trim().replace(/\s+/g, ' '); }
var tbl = container.tagName === 'TABLE' ? container
  : (container.children.length === 1 && container.firstElementChild && container.firstElementChild.tagName === 'TABLE' ? container.firstElementChild : null);
if (tbl) {
  var headers = [];
  var ths = tbl.querySelectorAll('thead th');
  for (var hi = 0; hi < ths.length; hi++) { if (ths[hi].closest('table') === tbl) headers.push(cellText(ths[hi])); }
  var bodyRows = [];
  var trs = tbl.querySelectorAll('tr');
  for (var ri = 0; ri < trs.length; ri++) {
    var tr = trs[ri];
    if (tr.closest('table') !== tbl || tr.cells.length < 2 || tr.closest('thead')) continue;
    bodyRows.push(tr);
  }
  if (!headers.length && bodyRows.length > 1) {
    var f = bodyRows[0];
    if (f.querySelectorAll('th').length === f.cells.length && f.cells.length >= 2) {
      for (var fi = 0; fi < f.cells.length; fi++) headers.push(cellText(f.cells[fi]));
      bodyRows.shift();
    }
  }
  var totalRows = bodyRows.length;
  var limited = bodyRows.slice(0, maxRows);
  var colCount = 0;
  limited.forEach(function(r) { if (r.cells.length > colCount) colCount = r.cells.length; });
  colCount = Math.min(colCount, 30);
  var used = Object.create(null), names = [];
  for (var c = 0; c < colCount; c++) {
    var nm = slug(headers[c]) || 'col_' + (c + 1);
    if (used[nm]) { used[nm]++; nm = nm + '_' + used[nm]; } else used[nm] = 1;
    names.push(nm);
  }
  var raw = limited.map(function(r) {
    var vals = [], hrefs = [];
    for (var c2 = 0; c2 < colCount; c2++) {
      var cell = r.cells[c2];
      vals.push(cell ? cellText(cell) : '');
      var a = cell && cell.querySelector('a[href]');
      hrefs.push(a ? a.href : '');
    }
    return { v: vals, u: hrefs };
  });
  var spec = [], columns = [];
  for (var c3 = 0; c3 < colCount; c3++) {
    var fill = raw.filter(function(r) { return r.v[c3]; }).length / raw.length;
    var linkFill = raw.filter(function(r) { return r.u[c3]; }).length / raw.length;
    if (fill >= 0.2) {
      spec.push({ name: names[c3], c: c3, href: false });
      columns.push({ name: names[c3], path: 'td:' + c3, fillRate: Math.round(fill * 100) / 100 });
    }
    if (linkFill >= 0.2) {
      spec.push({ name: names[c3] + '_url', c: c3, href: true });
      columns.push({ name: names[c3] + '_url', path: 'td:' + c3 + ' href', fillRate: Math.round(linkFill * 100) / 100 });
    }
  }
  var rows = raw.map(function(r) {
    var o = {};
    spec.forEach(function(s) { o[s.name] = (s.href ? r.u[s.c] : r.v[s.c]) || ''; });
    return o;
  });
  return { selector: sel, columns: columns, rows: rows, totalRows: totalRows, truncated: totalRows > maxRows };
}
var matching = getMatchingChildren(container);
var total2 = matching.length;
var rawRows = matching.slice(0, maxRows).map(function(el) { return extractRow(el, ''); });
if (!rawRows.length) return empty;
var keys = [], seenK = {};
rawRows.forEach(function(r) { for (var k in r) { if (!seenK[k]) { seenK[k] = 1; keys.push(k); } } });
var kept = [], byKey = {};
keys.forEach(function(key) {
  var values = rawRows.map(function(r) { return r[key] || ''; });
  var filled = values.filter(Boolean).length;
  var fillRate = filled / rawRows.length;
  if (fillRate < 0.2) return;
  var unique = Object.create(null);
  values.forEach(function(v) { if (v) unique[v] = 1; });
  if (Object.keys(unique).length <= 1 && rawRows.length > 2) return;
  var item = { key: key, fillRate: Math.round(fillRate * 100) / 100, values: values };
  kept.push(item);
  byKey[key] = item;
});
var ordered = [], usedKey = {};
kept.forEach(function(item) {
  if (usedKey[item.key]) return;
  var seg = item.key.split('/').filter(Boolean).pop() || '';
  if (/^a(\.|$)/.test(seg)) {
    ordered.push(item); usedKey[item.key] = 1;
    var href = byKey[item.key + ' href'];
    if (href && !usedKey[href.key]) { ordered.push(href); usedKey[href.key] = 1; }
  }
});
kept.forEach(function(item) { if (!usedKey[item.key]) { ordered.push(item); usedKey[item.key] = 1; } });
function contentHint(values) {
  var v = values.filter(Boolean).slice(0, 8);
  if (!v.length) return '';
  if (v.every(function(x) { return /^[$€£¥]\s?[\d,.]+/.test(x.trim()); })) return 'price';
  if (v.every(function(x) { return /^\(?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\)?$/i.test(x.trim()); })) return 'source_domain';
  return '';
}
var nameOf = {}, usedName = Object.create(null);
ordered.forEach(function(item, idx) {
  var seg = (item.key.split('/').filter(Boolean).pop() || '').replace(/ (href|src)$/, '');
  var suffix = / href$/.test(item.key) ? '_url' : (/ src$/.test(item.key) ? '_src' : '');
  var name = '';
  if (suffix) {
    var baseKey = item.key.replace(/ (href|src)$/, '');
    name = nameOf[baseKey] || '';
  }
  if (!name) {
    var cls = seg.indexOf('.') >= 0 ? seg.slice(seg.indexOf('.') + 1).split('.')[0] : '';
    name = contentHint(item.values) || slug((cls.split('__').pop() || '').split('--')[0]);
    if (!name && idx === 0) name = 'title';
    if (!name) name = slug(seg.split('.')[0]) || 'col';
  }
  name = name + suffix;
  if (usedName[name]) { usedName[name]++; name = name + '_' + usedName[name]; } else usedName[name] = 1;
  nameOf[item.key] = name;
});
var columns2 = ordered.map(function(item) { return { name: nameOf[item.key], path: item.key, fillRate: item.fillRate }; });
var rows2 = rawRows.map(function(r) {
  var o = {};
  ordered.forEach(function(item) { o[nameOf[item.key]] = r[item.key] || ''; });
  return o;
});
return { selector: sel, columns: columns2, rows: rows2, totalRows: total2, truncated: total2 > maxRows };
`;

/**
 * Live-DOM section walker. Emits a depth-capped SectionNode tree from semantic
 * tags, ARIA landmark roles, data-* component attributes, and PascalCase/BEM
 * class hints. Emits SELECTORS only — never [ref=eN] snapshot handles, which are
 * snapshot-scoped and would silently die between runs.
 *
 * A document navigated directly to a .xml/.svg URL has document.body === null;
 * the walk must degrade to an empty section list, not throw — the bridge turns
 * a throw into a rejection, so tools.ts's `?? {default}` fallback never sees it.
 */
const DETECT_SECTIONS_BODY = String.raw`
var maxDepth = opts.maxDepth;
var maxSections = opts.maxSections;
var MAX_VISIT = 30000;
var visited = 0, total = 0, truncated = false;
var SEMANTIC = Object.assign(Object.create(null), { SECTION: 1, ARTICLE: 1, ASIDE: 1, HEADER: 1, MAIN: 1, FOOTER: 1, NAV: 1, FORM: 1 });
var LANDMARKS = Object.assign(Object.create(null), { banner: 1, navigation: 1, main: 1, contentinfo: 1, complementary: 1, search: 1, form: 1, region: 1 });
var DATA_ATTRS = ['data-component', 'data-testid', 'data-section', 'data-block', 'data-module'];
var SKIP = Object.assign(Object.create(null), { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1 });
function classify(el) {
  if (SEMANTIC[el.tagName]) return { role: el.tagName.toLowerCase(), source: 'semantic-tag' };
  var role = el.getAttribute('role');
  if (role && LANDMARKS[role.toLowerCase()]) return { role: role.toLowerCase(), source: 'aria-landmark' };
  for (var i = 0; i < DATA_ATTRS.length; i++) {
    if (el.getAttribute(DATA_ATTRS[i])) return { role: DATA_ATTRS[i].slice(5), source: 'data-attr' };
  }
  var classes = getClasses(el);
  for (var j = 0; j < classes.length && j < 4; j++) {
    var c = classes[j];
    if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/.test(c)) return { role: c, source: 'class-hint' };
    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(c)) {
      for (var k = 0; k < el.children.length && k < 5; k++) {
        if (((el.children[k].className || '').toString()).indexOf(c + '__') >= 0) return { role: c, source: 'class-hint' };
      }
    }
  }
  return null;
}
function buildNode(el, cls, rect, depth) {
  var name = el.getAttribute('aria-label') || el.getAttribute('data-component') || '';
  if (!name) {
    var h = el.querySelector('h1,h2,h3,h4,h5,h6');
    if (h) name = (h.textContent || '').trim();
  }
  name = name.trim().substring(0, 80) || null;
  var headings = [];
  var hs = el.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (var i = 0; i < hs.length && headings.length < 5; i++) {
    var t = (hs[i].textContent || '').trim().substring(0, 80);
    if (t) headings.push(t);
  }
  var sel = buildSelector(el);
  return {
    role: cls.role,
    source: cls.source,
    name: name,
    selector: sel,
    selectorVerified: verifySelector(sel, el),
    box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
    interactiveCount: el.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"]').length,
    textLength: (el.textContent || '').trim().length,
    headings: headings,
    children: depth < maxDepth ? collect(el, depth + 1) : []
  };
}
function collect(parent, depth) {
  var out = [];
  var kids = parent.children;
  for (var i = 0; i < kids.length; i++) {
    if (truncated) break;
    var el = kids[i];
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || SKIP[el.tagName]) continue;
    if (++visited > MAX_VISIT) { truncated = true; break; }
    var cls = classify(el);
    if (cls) {
      var rect = el.getBoundingClientRect();
      if (rect.width >= 48 && rect.height >= 24) {
        if (total >= maxSections) { truncated = true; break; }
        total++;
        out.push(buildNode(el, cls, rect, depth));
        continue;
      }
    }
    var nested = collect(el, depth);
    for (var j = 0; j < nested.length; j++) out.push(nested[j]);
  }
  return out;
}
var sections = document.body ? collect(document.body, 1) : [];
return {
  url: location.href,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  sections: sections,
  totalDetected: total,
  truncated: truncated
};
`;

/**
 * Embed a value as a JavaScript literal.
 *
 * JSON.stringify is not quite enough on its own: U+2028 and U+2029 are legal in JSON but
 * are line terminators in JavaScript source, so it emits them raw. Modern engines accept
 * them inside string literals (ES2019 made JSON a JS superset), but the programs built here
 * are parsed by whatever Chrome the user happens to run, and escaping costs nothing.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildDetectTablesJs(opts: DetectTablesOptions = {}): string {
  const params = { maxCandidates: clampInt(opts.maxCandidates, 1, 20, 5) };
  const helpers = HELPER_GET_CLASSES + HELPER_MATCHING_CHILDREN + HELPER_BUILD_SELECTOR;
  return `/*crawlio:detect-tables*/(function(opts){${compact(helpers + DETECT_TABLES_BODY)}})(${jsLiteral(params)})`;
}

export function buildExtractTableJs(selector: string, opts: ExtractTableOptions = {}): string {
  const params = { maxRows: clampInt(opts.maxRows, 1, 1000, 200) };
  const helpers = HELPER_GET_CLASSES + HELPER_MATCHING_CHILDREN + HELPER_DIRECT_TEXT + HELPER_EXTRACT_ROW;
  return `/*crawlio:extract-table*/(function(sel, opts){${compact(helpers + EXTRACT_TABLE_BODY)}})(${jsLiteral(selector)}, ${jsLiteral(params)})`;
}

export function buildDetectSectionsJs(opts: DetectSectionsOptions = {}): string {
  const params = {
    maxDepth: clampInt(opts.maxDepth, 1, 5, 2),
    maxSections: clampInt(opts.maxSections, 1, 100, 40),
  };
  const helpers = HELPER_GET_CLASSES + HELPER_BUILD_SELECTOR + HELPER_VERIFY_SELECTOR;
  return `/*crawlio:detect-sections*/(function(opts){${compact(helpers + DETECT_SECTIONS_BODY)}})(${jsLiteral(params)})`;
}
