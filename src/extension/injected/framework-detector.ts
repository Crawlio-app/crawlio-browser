// Framework detection function — injected into page via cdpExecuteFunction (Runtime.evaluate)
// MUST be self-contained: no imports, no closures, no external references
// ah-17: multi-framework detection + version extraction + confidence scoring
 
export function detectFrameworkInPage(responseHeaders?: Record<string, string>): any {
  const w = window as any;
  const headers = responseHeaders || {};
  type Detection = { name: string; version?: string; confidence: "high" | "medium" | "low"; method: string };

  const META_FRAMEWORKS = new Set(["Next.js", "Nuxt", "SvelteKit", "Remix", "Gatsby", "Hydrogen", "Gridsome", "VuePress"]);
  const PARENT_MAP: Record<string, string> = {
    "Next.js": "React", "Nuxt": "Vue", "SvelteKit": "Svelte", "Remix": "React", "Gatsby": "React",
    "Hydrogen": "Shopify", "Gridsome": "Vue", "VuePress": "Vue",
  };

  // fw-hardening: case-insensitive header lookup (CDP returns original casing)
  const getHeader = (name: string): string => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return String(v);
    }
    return "";
  };

  // fw-hardening: boundary-aware cookie check (avoids "csrftoken" matching "mycsrftoken_v2")
  const hasCookie = (name: string): boolean => {
    return document.cookie.split(";").some(c => c.trim().startsWith(name + "="));
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
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    const rendererVersion = w.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.values?.()?.next?.()?.value?.version;
    detections.push({ name: "React", version: rendererVersion, confidence: "high", method: "global-var" });
  } else if (document.querySelector("[data-reactroot]")) {
    detections.push({ name: "React", confidence: "medium", method: "dom-attr" });
  }
  if (w.__vue_app__ || w.__VUE__) {
    detections.push({ name: "Vue.js", confidence: "high", method: "global-var" });
  }
  if (document.querySelector("[ng-version]")) {
    const ver = document.querySelector("[ng-version]")?.getAttribute("ng-version") ?? undefined;
    detections.push({ name: "Angular", version: ver, confidence: "high", method: "dom-attr" });
  }
  if (w.__svelte_meta || document.querySelector("[class*='svelte-']")) {
    detections.push({ name: "Svelte", confidence: w.__svelte_meta ? "high" : "medium", method: w.__svelte_meta ? "global-var" : "dom-attr" });
  }
  const astroMeta = document.querySelector('meta[name="generator"][content^="Astro"]');
  if (document.querySelector("astro-island") || astroMeta) {
    const ver = astroMeta?.getAttribute("content")?.match(/v([\d.]+)/)?.[1];
    detections.push({ name: "Astro", version: ver, confidence: "high", method: astroMeta ? "meta-generator" : "custom-element" });
  }

  // --- New frameworks (ah-17) ---
  if (document.documentElement.hasAttribute("q:container")) {
    detections.push({ name: "Qwik", confidence: "high", method: "html-attr" });
  }
  if (w._$HY) {
    detections.push({ name: "SolidJS", confidence: "high", method: "global-var" });
  }
  if (w.litElementVersions) {
    detections.push({ name: "Lit", confidence: "high", method: "global-var" });
  }
  if (w.__PREACT_DEVTOOLS__) {
    detections.push({ name: "Preact", confidence: "high", method: "global-var" });
  }
  if (document.querySelector("[x-data]")) {
    detections.push({ name: "Alpine.js", confidence: "medium", method: "dom-attr" });
  }
  if (document.querySelector("[hx-get],[hx-post],[hx-trigger]")) {
    detections.push({ name: "HTMX", version: w.htmx?.version, confidence: "medium", method: "dom-attr" });
  }
  if (document.querySelector("turbo-frame,turbo-stream") || w.Turbo) {
    detections.push({ name: "Turbo", confidence: w.Turbo ? "high" : "medium", method: w.Turbo ? "global-var" : "custom-element" });
  }
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

  // --- fw-hardening: header-based detection ---
  // Vercel — server: vercel, x-vercel-id, x-vercel-cache
  const serverH = getHeader("server");
  if (/^(vercel|now)$/i.test(serverH) || getHeader("x-vercel-id") || getHeader("x-vercel-cache")) {
    detections.push({ name: "Vercel", confidence: "high", method: "header" });
  }
  // Netlify — server: netlify, x-nf-request-id
  if (/^netlify/i.test(getHeader("server")) || getHeader("x-nf-request-id")) {
    detections.push({ name: "Netlify", confidence: "high", method: "header" });
  }
  // Hydrogen — powered-by: hydrogen
  const poweredBy = getHeader("powered-by") || getHeader("x-powered-by");
  if (/hydrogen/i.test(poweredBy)) {
    detections.push({ name: "Hydrogen", confidence: "high", method: "header" });
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
  // Cloudflare — cf-ray header, server: cloudflare, window.CloudFlare global
  const cfRay = getHeader("cf-ray");
  if (cfRay || /^cloudflare$/i.test(getHeader("server")) || getHeader("cf-cache-status")) {
    detections.push({ name: "Cloudflare", confidence: "high", method: "header" });
  } else if (w.CloudFlare) {
    detections.push({ name: "Cloudflare", confidence: "high", method: "global-var" });
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
  // PrestaShop — window.prestashop, meta generator, powered-by header, cookie
  if (w.prestashop) {
    detections.push({ name: "PrestaShop", confidence: "high", method: "global-var" });
  } else if (/^prestashop$/i.test(getHeader("powered-by") || getHeader("x-powered-by") || "")) {
    detections.push({ name: "PrestaShop", confidence: "high", method: "header" });
  } else {
    const prestaMeta = document.querySelector('meta[name="generator"][content*="PrestaShop"]');
    const hasPrestaShopCookie = document.cookie.split(";").some(c => c.trim().startsWith("PrestaShop-"));
    if (prestaMeta || hasPrestaShopCookie) {
      detections.push({ name: "PrestaShop", confidence: prestaMeta ? "medium" : "high", method: prestaMeta ? "meta-generator" : "cookie" });
    }
  }
  // OpenCart — link[href*="opencart"], OCSESSID cookie
  if (document.querySelector('link[href*="opencart"]') || hasCookie("OCSESSID")) {
    detections.push({ name: "OpenCart", confidence: hasCookie("OCSESSID") ? "high" : "medium", method: hasCookie("OCSESSID") ? "cookie" : "dom-attr" });
  }
  // Hydrogen — ALREADY DETECTED (fw-hardening, header-based)

  // --- Pre-load hook data enrichment (cv-2) ---
  const hookData = w.__CRAWLIO_FRAMEWORK_DATA__;
  if (hookData) {
    // Enrich React detection with hook-captured renderer info
    if (hookData.react) {
      const reactDet = detections.find(d => d.name === "React");
      if (reactDet && !reactDet.version && hookData.react.version) {
        reactDet.version = hookData.react.version;
      }
    }
    // Enrich Vue detection with hook-captured version
    if (hookData.vue) {
      const vueDet = detections.find(d => d.name === "Vue.js");
      if (vueDet && !vueDet.version && hookData.vue.version) {
        vueDet.version = hookData.vue.version;
      }
    }
  }

  // --- Multi-framework resolution ---
  const metaDetection = detections.find(d => META_FRAMEWORKS.has(d.name));
  const primary = metaDetection || detections[0];
  const subFrameworks = detections.filter(d => d !== primary);

  const framework = primary ? (PARENT_MAP[primary.name] || primary.name) : "Unknown";
  const subtype = primary && META_FRAMEWORKS.has(primary.name) ? primary.name : undefined;
  const confidence = primary?.confidence ?? "low";
  const signals = detections.map(d => d.method + ":" + d.name);
  const version = primary?.version;
  let ssrMode: string | undefined;
  if (primary?.name === "Next.js") {
    ssrMode = w.__NEXT_DATA__?.runtimeConfig ? "hybrid" : (document.querySelector("next-route-announcer") ? "app-router" : "static");
  }

  // Include hook data if available — provides pre-load initialization data
  const frameworkData = hookData ? {
    react: hookData.react || undefined,
    vue: hookData.vue || undefined,
    nextjs: hookData.nextjs || undefined,
    nuxt: hookData.nuxt || undefined,
  } : undefined;

  return { framework, subtype, confidence, signals, version, ssrMode, detections, primary, subFrameworks, frameworkData };
}
