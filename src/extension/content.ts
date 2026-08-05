// Content script — injected at document_idle on all URLs
// Uses persistent port for fire-and-forget messages, onMessage for request-response

// Marker so background can check if content script is injected before sendMessage
(window as any).__crawlio_content = true;

// --- Port Connection with Reconnection ---
let port: chrome.runtime.Port | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "crawlio-content" });
  } catch {
    port = null;
    return; // Extension context invalid — no point reconnecting
  }
  reconnectAttempts = 0;

  port.onDisconnect.addListener(() => {
    port = null;
    // Must check lastError to clear it (Chrome logs warning if unchecked)
    const lastErr = chrome.runtime.lastError?.message;
    // Don't reconnect if extension context is gone — connect would throw anyway
    if (lastErr?.includes("Extension context invalidated")) return;
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 4000);
      setTimeout(connectPort, delay);
    }
  });
}

connectPort();

// Request-response messages stay on runtime.onMessage (DETECT_FRAMEWORK, GET_DOM_SNAPSHOT)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "DETECT_FRAMEWORK") {
    try {
      sendResponse(detectFramework());
    } catch (e) {
      sendResponse({ error: `detectFramework failed: ${e}` });
    }
    return true;
  }

  if (message.type === "GET_DOM_SNAPSHOT") {
    try {
      sendResponse(getDOMSnapshot(message.maxDepth ?? 10));
    } catch (e) {
      sendResponse({ error: `getDOMSnapshot failed: ${e}` });
    }
    return true;
  }
});

// Boundary-aware cookie check — avoids false positives from substring matching
function hasCookie(name: string): boolean {
  return document.cookie.split(';').some(c => c.trim().startsWith(name + '='));
}

// --- Framework Detection (ah-17: multi-framework + version extraction + confidence) ---

function detectFramework(): any {
  const w = window as any;
  type Detection = { name: string; version?: string; confidence: "high" | "medium" | "low"; method: string };

  const META_FRAMEWORKS = new Set(["Next.js", "Nuxt", "SvelteKit", "Remix", "Gatsby", "Hydrogen", "Gridsome", "VuePress"]);
  const PARENT_MAP: Record<string, string> = {
    "Next.js": "React", "Nuxt": "Vue", "SvelteKit": "Svelte", "Remix": "React", "Gatsby": "React",
    "Hydrogen": "Shopify", "Gridsome": "Vue", "VuePress": "Vue",
  };

  const detections: Detection[] = [];

  // --- Meta-frameworks (high confidence, global vars) ---
  const hasNextGlobals = w.__NEXT_DATA__ || w.__next_f;
  const hasNextRouteAnnouncer = !!document.querySelector("next-route-announcer");
  const hasNextDiv = !!document.querySelector("#__next");
  const hasNextScripts = !!document.querySelector("script[src*='/_next/']");
  if (hasNextGlobals || hasNextRouteAnnouncer || (hasNextDiv && hasNextScripts)) {
    detections.push({ name: "Next.js", version: w.__NEXT_DATA__?.buildId, confidence: "high", method: "global-var" });
  }
  if (w.__NUXT__ || w.__nuxt) {
    detections.push({ name: "Nuxt", version: w.__NUXT__?.config?.app?.buildId, confidence: "high", method: "global-var" });
  }
  if (w.__sveltekit) {
    detections.push({ name: "SvelteKit", confidence: "high", method: "global-var" });
  }
  if (w.__remixContext) {
    detections.push({ name: "Remix", confidence: "high", method: "global-var" });
  }
  if (w.___gatsby) {
    detections.push({ name: "Gatsby", confidence: "high", method: "global-var" });
  }

  // --- Core frameworks ---
  // React
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    const rendererVersion = w.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.values?.()?.next?.()?.value?.version;
    detections.push({ name: "React", version: rendererVersion, confidence: "high", method: "global-var" });
  } else if (document.querySelector("[data-reactroot]")) {
    detections.push({ name: "React", confidence: "medium", method: "dom-attr" });
  }
  // Vue
  if (w.__vue_app__ || w.__VUE__) {
    detections.push({ name: "Vue.js", confidence: "high", method: "global-var" });
  }
  // Angular
  if (document.querySelector("[ng-version]")) {
    const ver = document.querySelector("[ng-version]")?.getAttribute("ng-version") ?? undefined;
    detections.push({ name: "Angular", version: ver, confidence: "high", method: "dom-attr" });
  }
  // Svelte
  if (w.__svelte_meta || document.querySelector("[class*='svelte-']")) {
    detections.push({ name: "Svelte", confidence: w.__svelte_meta ? "high" : "medium", method: w.__svelte_meta ? "global-var" : "dom-attr" });
  }
  // Astro
  const astroMeta = document.querySelector('meta[name="generator"][content^="Astro"]');
  if (document.querySelector("astro-island") || astroMeta) {
    const ver = astroMeta?.getAttribute("content")?.match(/v([\d.]+)/)?.[1];
    detections.push({ name: "Astro", version: ver, confidence: "high", method: astroMeta ? "meta-generator" : "custom-element" });
  }

  // --- New frameworks (ah-17) ---
  // Qwik: <html q:container>
  if (document.documentElement.hasAttribute("q:container")) {
    detections.push({ name: "Qwik", confidence: "high", method: "html-attr" });
  }
  // SolidJS: window._$HY (hydration marker)
  if (w._$HY) {
    detections.push({ name: "SolidJS", confidence: "high", method: "global-var" });
  }
  // Lit: litElementVersions global
  if (w.litElementVersions) {
    detections.push({ name: "Lit", confidence: "high", method: "global-var" });
  }
  // Preact
  if (w.__PREACT_DEVTOOLS__) {
    detections.push({ name: "Preact", confidence: "high", method: "global-var" });
  }
  // Alpine.js: [x-data] attribute
  if (document.querySelector("[x-data]")) {
    detections.push({ name: "Alpine.js", confidence: "medium", method: "dom-attr" });
  }
  // HTMX: [hx-get], [hx-post], [hx-trigger] attributes
  if (document.querySelector("[hx-get],[hx-post],[hx-trigger]")) {
    detections.push({ name: "HTMX", version: w.htmx?.version, confidence: "medium", method: "dom-attr" });
  }
  // Turbo: <turbo-frame>, <turbo-stream> custom elements
  if (document.querySelector("turbo-frame,turbo-stream") || w.Turbo) {
    detections.push({ name: "Turbo", confidence: w.Turbo ? "high" : "medium", method: w.Turbo ? "global-var" : "custom-element" });
  }
  // Stencil: [s-id] attribute
  if (document.querySelector("[s-id]")) {
    detections.push({ name: "Stencil", confidence: "medium", method: "dom-attr" });
  }

  // --- CMS/Platforms ---
  if (document.querySelector("link[href*='wp-content']") || document.querySelector("script[src*='wp-includes']")) {
    detections.push({ name: "WordPress", confidence: "medium", method: "dom-attr" });
  }
  if (document.querySelector("[data-wf-site]")) {
    detections.push({ name: "Webflow", confidence: "high", method: "dom-attr" });
  }

  // --- E-commerce + Builders + CMS (fw-tier1) ---
  // Shopify — window.Shopify, link[href*='shopify.com']
  if (w.Shopify || w.ShopifyAPI) {
    detections.push({ name: "Shopify", version: w.Shopify?.version, confidence: "high", method: "global-var" });
  } else if (document.querySelector("link[href*='shopify.com']")) {
    detections.push({ name: "Shopify", confidence: "high", method: "dom-attr" });
  }
  // WooCommerce — window.woocommerce_params, .woocommerce class — implies WordPress
  if (w.woocommerce_params) {
    detections.push({ name: "WooCommerce", confidence: "high", method: "global-var" });
  } else if (document.querySelector(".woocommerce") || document.querySelector("link[rel*='woocommerce']")) {
    detections.push({ name: "WooCommerce", confidence: "high", method: "dom-attr" });
  }
  // Squarespace — window.Squarespace
  if (w.Squarespace) {
    detections.push({ name: "Squarespace", confidence: "high", method: "global-var" });
  }
  // Wix — window.wixBiSession
  if (w.wixBiSession || w.wixPerformanceMeasurements) {
    detections.push({ name: "Wix", confidence: "high", method: "global-var" });
  }
  // Framer — window.__framer_importFromPackage
  if (w.__framer_importFromPackage) {
    detections.push({ name: "Framer", confidence: "high", method: "global-var" });
  }
  // Drupal — window.Drupal
  if (w.Drupal) {
    detections.push({ name: "Drupal", confidence: "high", method: "global-var" });
  }
  // Magento — window.Mage, script[type='text/x-magento-init']
  if (w.Mage || w.VarienForm) {
    detections.push({ name: "Magento", confidence: "high", method: "global-var" });
  } else if (document.querySelector("script[type='text/x-magento-init']") || document.querySelector("script[data-requiremodule*='Magento_']")) {
    detections.push({ name: "Magento", confidence: "high", method: "dom-attr" });
  }
  // Joomla — window.Joomla
  if (w.Joomla) {
    detections.push({ name: "Joomla", confidence: "high", method: "global-var" });
  }
  // Ghost — meta generator only
  const ghostMeta = document.querySelector('meta[name="generator"][content*="Ghost"]');
  if (ghostMeta) {
    const ver = ghostMeta.getAttribute("content")?.match(/Ghost\s+([\d.]+)/)?.[1];
    detections.push({ name: "Ghost", version: ver, confidence: "medium", method: "meta-generator" });
  }
  // Bubble — window._bubble_page_load_data
  if (w._bubble_page_load_data || w.bubble_environment) {
    detections.push({ name: "Bubble", version: w.bubble_version, confidence: "high", method: "global-var" });
  }

  // --- fw-hardening: DOM-based weak-signal frameworks ---
  // Carrd — carrd.co
  if (w.location?.hostname?.includes("carrd.co") || document.querySelector('link[href*="carrd.co"]')) {
    detections.push({ name: "Carrd", confidence: "medium", method: "url-pattern" });
  }
  // Gridsome — meta generator only, no global in binary
  const gridsomeMeta = document.querySelector('meta[name="generator"][content*="Gridsome"]');
  if (gridsomeMeta) {
    const ver = gridsomeMeta.getAttribute("content")?.match(/v([\d.]+)/)?.[1];
    detections.push({ name: "Gridsome", version: ver, confidence: "medium", method: "meta-generator" });
  }

  // --- JS Libraries + CSS (fw-tier2) ---
  // jQuery — window.jQuery.fn.jquery
  if (w.jQuery || w.$?.fn?.jquery) {
    detections.push({ name: "jQuery", version: w.jQuery?.fn?.jquery || w.$?.fn?.jquery, confidence: "high", method: "global-var" });
  }
  // Bootstrap — window.bootstrap.Alert.VERSION
  if (w.bootstrap?.Alert?.VERSION || w.jQuery?.fn?.tooltip?.Constructor?.VERSION) {
    detections.push({ name: "Bootstrap", version: w.bootstrap?.Alert?.VERSION || w.jQuery?.fn?.tooltip?.Constructor?.VERSION, confidence: "high", method: "global-var" });
  }
  // Tailwind CSS — window.tailwind, link[href*='tailwind']
  if (w.tailwind) {
    detections.push({ name: "Tailwind CSS", confidence: "high", method: "global-var" });
  } else if (document.querySelector("link[rel='stylesheet'][href*='tailwind']")) {
    detections.push({ name: "Tailwind CSS", confidence: "medium", method: "dom-attr" });
  }
  // Backbone.js — window.Backbone
  if (w.Backbone) {
    detections.push({ name: "Backbone.js", version: w.Backbone.VERSION, confidence: "high", method: "global-var" });
  }
  // Ember.js — window.Ember, window.EmberENV
  if (w.Ember || w.EmberENV) {
    detections.push({ name: "Ember.js", version: w.Ember?.VERSION, confidence: "high", method: "global-var" });
  }
  // Knockout — window.ko.version
  if (w.ko) {
    detections.push({ name: "Knockout", version: w.ko.version, confidence: "high", method: "global-var" });
  }
  // Polymer — window.Polymer.version
  if (w.Polymer) {
    detections.push({ name: "Polymer", version: w.Polymer.version, confidence: "high", method: "global-var" });
  }
  // Stimulus — data-controller attribute
  if (document.querySelector("[data-controller]")) {
    detections.push({ name: "Stimulus", confidence: "medium", method: "dom-attr" });
  }
  // Marko — window.markoComponent, [data-marko-key]
  if (w.markoComponent || w.markoSections || w.markoVars) {
    detections.push({ name: "Marko", confidence: "high", method: "global-var" });
  } else if (document.querySelector("[data-marko-key]") || document.documentElement.getAttribute("data-framework") === "marko") {
    detections.push({ name: "Marko", confidence: "high", method: "dom-attr" });
  }
  // Riot — window.riot
  if (w.riot) {
    detections.push({ name: "Riot", version: w.riot.version, confidence: "high", method: "global-var" });
  }
  // Mithril — script URL + public window.m check
  if (w.m && typeof w.m.render === "function") {
    detections.push({ name: "Mithril", version: w.m.version, confidence: "high", method: "global-var" });
  } else if (document.querySelector('script[src*="mithril"]')) {
    detections.push({ name: "Mithril", confidence: "medium", method: "script-src" });
  }
  // Inferno — window.Inferno
  if (w.Inferno) {
    detections.push({ name: "Inferno", version: w.Inferno.version, confidence: "high", method: "global-var" });
  }

  // --- Backend + Hosting + SSGs (fw-tier3) ---
  // Laravel — window.Laravel, cookie laravel_session, csrf-token meta
  if (w.Laravel) {
    detections.push({ name: "Laravel", confidence: "high", method: "global-var" });
  } else if (document.querySelector('meta[name="csrf-token"]') || document.querySelector('input[name="_token"]')) {
    const hasCsrfCookie = hasCookie("XSRF-TOKEN") || hasCookie("laravel_session");
    if (hasCsrfCookie || document.querySelector('meta[name="csrf-token"]')) {
      detections.push({ name: "Laravel", confidence: hasCsrfCookie ? "high" : "medium", method: hasCsrfCookie ? "cookie" : "dom-attr" });
    }
  }
  // Django — window.django, window.__admin_media_prefix__, csrfmiddlewaretoken input, csrftoken cookie
  if (w.django || w.__admin_media_prefix__) {
    detections.push({ name: "Django", confidence: "high", method: "global-var" });
  } else if (document.querySelector('input[name="csrfmiddlewaretoken"]') || hasCookie("csrftoken")) {
    detections.push({ name: "Django", confidence: "medium", method: hasCookie("csrftoken") ? "cookie" : "dom-attr" });
  }
  // Ruby on Rails — window._rails_loaded, csrf-param meta, _session_id cookie
  if (w._rails_loaded) {
    detections.push({ name: "Ruby on Rails", confidence: "high", method: "global-var" });
  } else {
    const railsMeta = document.querySelector('meta[name="csrf-param"][content="authenticity_token"]');
    if (railsMeta) {
      detections.push({ name: "Ruby on Rails", confidence: "high", method: "dom-attr" });
    }
  }
  // Cloudflare — window.CloudFlare global, DOM fallback — no headers in content script
  if (w.CloudFlare) {
    detections.push({ name: "Cloudflare", confidence: "high", method: "global-var" });
  } else if (document.querySelector('img[src*="cdn.cloudflare"]') || document.querySelector('script[src*="cloudflare"]')) {
    detections.push({ name: "Cloudflare", confidence: "medium", method: "dom-attr" });
  }
  // Hugo — meta generator
  const hugoMeta = document.querySelector('meta[name="generator"][content*="Hugo"]');
  if (hugoMeta) {
    const ver = hugoMeta.getAttribute("content")?.match(/(\d[\d.]+)/)?.[1];
    detections.push({ name: "Hugo", version: ver, confidence: "high", method: "meta-generator" });
  }
  // Jekyll — window.SimpleJekyllSearch, meta generator
  if (w.SimpleJekyllSearch) {
    detections.push({ name: "Jekyll", confidence: "high", method: "global-var" });
  } else {
    const jekyllMeta = document.querySelector('meta[name="generator"][content*="Jekyll"]');
    if (jekyllMeta) {
      const ver = jekyllMeta.getAttribute("content")?.match(/(\d[\d.]+)/)?.[1];
      detections.push({ name: "Jekyll", version: ver, confidence: "medium", method: "meta-generator" });
    }
  }
  // Hexo — meta generator only
  const hexoMeta = document.querySelector('meta[name="generator"][content*="Hexo"]');
  if (hexoMeta) {
    const ver = hexoMeta.getAttribute("content")?.match(/(\d[\d.]+)/)?.[1];
    detections.push({ name: "Hexo", version: ver, confidence: "medium", method: "meta-generator" });
  }
  // Docusaurus — window.docusaurus, __DOCUSAURUS_INSERT_BASEURL_BANNER, meta generator
  if (w.docusaurus || w.__DOCUSAURUS_INSERT_BASEURL_BANNER) {
    detections.push({ name: "Docusaurus", confidence: "high", method: "global-var" });
  } else {
    const docuMeta = document.querySelector('meta[name="generator"][content*="Docusaurus"]');
    if (docuMeta) {
      const ver = docuMeta.getAttribute("content")?.match(/(\d[\d.]+)/)?.[1];
      detections.push({ name: "Docusaurus", version: ver, confidence: "medium", method: "meta-generator" });
    }
  }
  // VuePress — window.__VUEPRESS__, meta generator — implies Vue
  if (w.__VUEPRESS__) {
    detections.push({ name: "VuePress", version: w.__VUEPRESS__?.version, confidence: "high", method: "global-var" });
  } else {
    const vuepressMeta = document.querySelector('meta[name="generator"][content*="VuePress"]');
    if (vuepressMeta) {
      const ver = vuepressMeta.getAttribute("content")?.match(/(\d[\d.]+)/)?.[1];
      detections.push({ name: "VuePress", version: ver, confidence: "medium", method: "meta-generator" });
    }
  }
  // Eleventy — meta generator only
  const eleventyMeta = document.querySelector('meta[name="generator"][content*="Eleventy"]');
  if (eleventyMeta) {
    const ver = eleventyMeta.getAttribute("content")?.match(/(\d[\d.]+)/)?.[1];
    detections.push({ name: "Eleventy", version: ver, confidence: "medium", method: "meta-generator" });
  }

  // --- Long-tail Builders + E-commerce (fw-tier4) ---
  // GoDaddy — cookie dps_site_id, meta generator
  const godaddyMeta = document.querySelector('meta[name="generator"][content*="GoDaddy"]');
  if (godaddyMeta || hasCookie("dps_site_id")) {
    detections.push({ name: "GoDaddy", confidence: hasCookie("dps_site_id") ? "high" : "medium", method: hasCookie("dps_site_id") ? "cookie" : "meta-generator" });
  }
  // Tilda — script src tildacdn
  if (document.querySelector('script[src*="tildacdn"]') || document.querySelector('link[href*="tildacdn"]')) {
    detections.push({ name: "Tilda", confidence: "medium", method: "script-src" });
  }
  // Duda — window.SystemID, window.d_version, multiscreensite.com scripts
  if (w.SystemID || w.d_version) {
    detections.push({ name: "Duda", confidence: "high", method: "global-var" });
  } else if (document.querySelector('script[src*="multiscreensite.com"]')) {
    detections.push({ name: "Duda", confidence: "medium", method: "script-src" });
  }
  // Weebly — window._W.configDomain, editmysite.com scripts
  if (w._W?.configDomain) {
    detections.push({ name: "Weebly", confidence: "high", method: "global-var" });
  } else if (document.querySelector('script[src*="editmysite.com"]')) {
    detections.push({ name: "Weebly", confidence: "medium", method: "script-src" });
  }
  // Carrd — ALREADY DETECTED (fw-hardening)
  // BigCommerce — window.bigcommerce_config, .bigcommerce.com assets
  if (w.bigcommerce_config || w.bigcommerce_i18n) {
    detections.push({ name: "BigCommerce", confidence: "high", method: "global-var" });
  } else if (document.querySelector('link[href*=".bigcommerce.com"]') || document.querySelector('img[src*=".bigcommerce.com"]')) {
    detections.push({ name: "BigCommerce", confidence: "high", method: "dom-attr" });
  }
  // PrestaShop — window.prestashop, meta generator, cookie — no headers in content script
  if (w.prestashop) {
    detections.push({ name: "PrestaShop", confidence: "high", method: "global-var" });
  } else {
    const prestaMeta = document.querySelector('meta[name="generator"][content*="PrestaShop"]');
    if (prestaMeta || hasCookie("prestashop")) {
      detections.push({ name: "PrestaShop", confidence: prestaMeta ? "medium" : "high", method: prestaMeta ? "meta-generator" : "cookie" });
    }
  }
  // OpenCart — link[href*="opencart"], ocsessid cookie
  if (document.querySelector('link[href*="opencart"]') || hasCookie("ocsessid")) {
    detections.push({ name: "OpenCart", confidence: hasCookie("ocsessid") ? "high" : "medium", method: hasCookie("ocsessid") ? "cookie" : "dom-attr" });
  }
  // Hydrogen — content script has no header access (header-based detection in background.ts only)

  // --- Multi-framework resolution ---
  const metaDetection = detections.find(d => META_FRAMEWORKS.has(d.name));
  const primary = metaDetection || detections[0];
  const subFrameworks = detections.filter(d => d !== primary);

  // Backward-compatible fields
  const framework = primary ? (PARENT_MAP[primary.name] || primary.name) : "Unknown";
  const subtype = primary && META_FRAMEWORKS.has(primary.name) ? primary.name : undefined;
  const confidence = primary?.confidence ?? "low";
  const signals = detections.map(d => d.method + ":" + d.name);
  const version = primary?.version;
  let ssrMode: string | undefined;
  if (primary?.name === "Next.js") {
    ssrMode = w.__NEXT_DATA__?.runtimeConfig ? "hybrid" : (document.querySelector("next-route-announcer") ? "app-router" : "static");
  }

  return { framework, subtype, confidence, signals, version, ssrMode, detections, primary, subFrameworks };
}

// --- DOM Snapshot (ah-18: shadow DOM + iframes + size limiting + sanitization) ---

function getDOMSnapshot(maxDepth: number): any {
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT"]);
  const EVENT_RE = /^on[a-z]+$/i;
  const MAX_SNAPSHOT = 5 * 1024 * 1024; // 5MB
  const MAX_NODES = 50_000;
  let nodeCount = 0;
  let nodeLimitReached = false;
  let shadowRootCount = 0;
  let maxDepthReached = 0;

  function walk(el: Element, depth: number): any {
    if (depth > maxDepth) return null;
    if (nodeCount >= MAX_NODES) { nodeLimitReached = true; return null; }
    nodeCount++;
    if (depth > maxDepthReached) maxDepthReached = depth;
    if (SKIP.has(el.tagName)) return null;
    const node: any = { tag: el.tagName.toLowerCase() };
    if (el.attributes.length) {
      node.attrs = {};
      for (const a of Array.from(el.attributes)) {
        // Sanitize: skip inline event handlers (onclick, onerror, etc.)
        if (EVENT_RE.test(a.name)) continue;
        node.attrs[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + "..." : a.value;
      }
    }
    if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
      const t = el.textContent?.trim();
      if (t) node.text = t.length > 200 ? t.slice(0, 200) + "..." : t;
    }
    const ch: any[] = [];
    for (const c of Array.from(el.children)) {
      const r = walk(c, depth + 1);
      if (r) ch.push(r);
    }
    // Shadow DOM traversal
    if (el.shadowRoot) {
      shadowRootCount++;
      for (const c of Array.from(el.shadowRoot.children)) {
        const r = walk(c, depth + 1);
        if (r) { r.isShadowRoot = true; ch.push(r); }
      }
    }
    if (ch.length) node.children = ch;
    return node;
  }

  // Build tree
  const tree = walk(document.documentElement, 0);

  // Capture iframes (same-origin content, cross-origin URL only)
  const iframes: Array<{ src: string; content?: string }> = [];
  for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
    try {
      const innerDoc = (iframe as HTMLIFrameElement).contentDocument;
      if (innerDoc) {
        iframes.push({ src: (iframe as HTMLIFrameElement).src, content: innerDoc.documentElement.outerHTML });
      } else {
        iframes.push({ src: (iframe as HTMLIFrameElement).src });
      }
    } catch {
      iframes.push({ src: (iframe as HTMLIFrameElement).src });
    }
  }

  // HTML snapshot with shadow DOM serialization
  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
    let html = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        html += serializeElement(child as Element);
      } else if (child.nodeType === Node.TEXT_NODE) {
        html += child.textContent || "";
      }
    }
    return html;
  }

  function serializeElement(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "script") return `<script>[stripped]</script>`;
    const attrs = Array.from(el.attributes)
      .filter(a => !EVENT_RE.test(a.name))
      .map(a => ` ${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join("");
    let inner = "";
    if (el.shadowRoot) {
      inner += `<template shadowrootmode="${el.shadowRoot.mode}">`;
      inner += serializeNode(el.shadowRoot);
      inner += `</template>`;
    }
    inner += serializeNode(el);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  let html = serializeElement(document.documentElement);

  // Size limiting with progressive stripping
  let truncated = false;
  if (html.length > MAX_SNAPSHOT) {
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script>[stripped]</script>");
    truncated = true;
  }
  if (html.length > MAX_SNAPSHOT) {
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style>[stripped]</style>");
  }
  if (html.length > MAX_SNAPSHOT) {
    html = html.slice(0, MAX_SNAPSHOT);
  }

  const metadata = {
    sizeBytes: html.length,
    truncated: truncated || nodeLimitReached,
    shadowRoots: shadowRootCount,
    iframeCount: iframes.length,
    depth: maxDepthReached,
    ...(nodeLimitReached ? { _truncated: true, nodeCount, maxNodes: MAX_NODES } : {}),
  };

  return { tree, html, iframes, metadata };
}
