// Technographic fingerprint database + matcher
// Curated top-200 technology fingerprints, matched against page markup, headers, scripts,
// cookies and JS globals.
// Additive confidence scoring: per-pattern weights summed, capped at 100

import type {
  TechnologyFingerprint,
  TechnologyCategory,
  TechDetection,
  TechRelationship,
  TechnographicResult,
  CapturedSignals,
} from "../shared/evidence-types.js";

// --- Pattern parsing ---

interface CompiledPattern {
  regex: RegExp;
  confidence: number;
  version: string;
}

/**
 * Parse a fingerprint pattern string into a compiled regex + metadata.
 * Pattern format: `regex\\;confidence:N\\;version:\\1`
 * ReDoS protection: unescaped `+` → `{1,250}`, `*` → `{0,250}`
 */
export function parsePattern(pattern: string): CompiledPattern {
  const parts = pattern.toString().split("\\;");
  let confidence = 100;
  let version = "";
  let regexStr = parts[0] || "";

  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(":");
    if (colonIdx > 0) {
      const key = parts[i].substring(0, colonIdx);
      const val = parts[i].substring(colonIdx + 1);
      if (key === "confidence") {
        const parsed = parseInt(val, 10);
        confidence = isNaN(parsed) ? 100 : parsed;
      } else if (key === "version") {
        version = val;
      }
    }
  }

  // ReDoS protection — limit quantifiers
  regexStr = regexStr
    .replace(/\//g, "\\/")
    .replace(/\\\+/g, "__escapedPlus__")
    .replace(/\+/g, "{1,250}")
    .replace(/\*/g, "{0,250}")
    .replace(/__escapedPlus__/g, "\\+");

  let regex: RegExp;
  try {
    regex = new RegExp(regexStr, "i");
  } catch {
    regex = new RegExp("$^"); // never matches
  }

  return { regex, confidence, version };
}

/**
 * Resolve a version from a regex match using the \\1-style back-reference syntax.
 * Supports: \\1 back-references, \\1?yes:no ternary
 */
export function resolveVersion(pattern: CompiledPattern, match: string): string {
  let resolved = pattern.version;
  if (!resolved) return "";

  const matches = pattern.regex.exec(match);
  if (!matches) return resolved;

  for (let i = 0; i < matches.length; i++) {
    const group = matches[i] || "";
    if (group.length > 15) continue; // Skip overly long strings

    // Ternary: \\1?yes:no
    const ternary = new RegExp(`\\\\${i}\\?([^:]+):(.+?)$`).exec(resolved);
    if (ternary && ternary.length === 3) {
      resolved = resolved.replace(ternary[0], group ? ternary[1] : ternary[2]);
    }

    // Back-references: \\1
    resolved = resolved.replace(new RegExp(`\\\\${i}`, "g"), group);
  }

  // Remove unmatched back-references
  resolved = resolved.replace(/\\\d/g, "").trim();
  return resolved;
}

// --- Category Taxonomy (curated subset) ---

const CATEGORIES: Record<number, TechnologyCategory> = {
  1: { id: 1, name: "CMS", slug: "cms" },
  2: { id: 2, name: "Message board", slug: "message-board" },
  3: { id: 3, name: "Database manager", slug: "database-manager" },
  4: { id: 4, name: "Documentation", slug: "documentation" },
  5: { id: 5, name: "Widget", slug: "widget" },
  6: { id: 6, name: "Ecommerce", slug: "ecommerce" },
  7: { id: 7, name: "Photo gallery", slug: "photo-gallery" },
  8: { id: 8, name: "Wiki", slug: "wiki" },
  9: { id: 9, name: "Hosting panel", slug: "hosting-panel" },
  10: { id: 10, name: "Analytics", slug: "analytics" },
  11: { id: 11, name: "Blog", slug: "blog" },
  12: { id: 12, name: "JavaScript framework", slug: "javascript-framework" },
  13: { id: 13, name: "Issue tracker", slug: "issue-tracker" },
  14: { id: 14, name: "Video player", slug: "video-player" },
  15: { id: 15, name: "Comment system", slug: "comment-system" },
  16: { id: 16, name: "Security", slug: "security" },
  17: { id: 17, name: "Font script", slug: "font-script" },
  18: { id: 18, name: "Web framework", slug: "web-framework" },
  19: { id: 19, name: "Miscellaneous", slug: "miscellaneous" },
  20: { id: 20, name: "Editor", slug: "editor" },
  21: { id: 21, name: "LMS", slug: "lms" },
  22: { id: 22, name: "Web server", slug: "web-server" },
  23: { id: 23, name: "Cache tool", slug: "cache-tool" },
  25: { id: 25, name: "JavaScript library", slug: "javascript-library" },
  26: { id: 26, name: "Mobile framework", slug: "mobile-framework" },
  27: { id: 27, name: "Programming language", slug: "programming-language" },
  29: { id: 29, name: "Search engine", slug: "search-engine" },
  30: { id: 30, name: "Web mail", slug: "web-mail" },
  31: { id: 31, name: "CDN", slug: "cdn" },
  32: { id: 32, name: "Marketing automation", slug: "marketing-automation" },
  33: { id: 33, name: "Web server extension", slug: "web-server-extension" },
  34: { id: 34, name: "Database", slug: "database" },
  35: { id: 35, name: "Map", slug: "map" },
  36: { id: 36, name: "Advertising", slug: "advertising" },
  37: { id: 37, name: "Network device", slug: "network-device" },
  38: { id: 38, name: "Media server", slug: "media-server" },
  39: { id: 39, name: "Webcam", slug: "webcam" },
  41: { id: 41, name: "Payment processor", slug: "payment-processor" },
  42: { id: 42, name: "Tag manager", slug: "tag-manager" },
  44: { id: 44, name: "CI", slug: "ci" },
  47: { id: 47, name: "Live chat", slug: "live-chat" },
  48: { id: 48, name: "CRM", slug: "crm" },
  50: { id: 50, name: "SEO", slug: "seo" },
  51: { id: 51, name: "Accounting", slug: "accounting" },
  52: { id: 52, name: "Cryptominer", slug: "cryptominer" },
  53: { id: 53, name: "Static site generator", slug: "static-site-generator" },
  54: { id: 54, name: "User onboarding", slug: "user-onboarding" },
  55: { id: 55, name: "RUM", slug: "rum" },
  56: { id: 56, name: "Geolocation", slug: "geolocation" },
  57: { id: 57, name: "Cookie compliance", slug: "cookie-compliance" },
  58: { id: 58, name: "Accessibility", slug: "accessibility" },
  59: { id: 59, name: "UI framework", slug: "ui-framework" },
  60: { id: 60, name: "Paas", slug: "paas" },
  61: { id: 61, name: "Retargeting", slug: "retargeting" },
  62: { id: 62, name: "Reverse proxy", slug: "reverse-proxy" },
  63: { id: 63, name: "Load balancer", slug: "load-balancer" },
  64: { id: 64, name: "UI library", slug: "ui-library" },
  65: { id: 65, name: "A/B testing", slug: "ab-testing" },
  66: { id: 66, name: "Hosting", slug: "hosting" },
  67: { id: 67, name: "Translation", slug: "translation" },
  68: { id: 68, name: "Reviews", slug: "reviews" },
  69: { id: 69, name: "Buy now pay later", slug: "buy-now-pay-later" },
  70: { id: 70, name: "Performance", slug: "performance" },
  71: { id: 71, name: "Personalisation", slug: "personalisation" },
  72: { id: 72, name: "Segmentation", slug: "segmentation" },
  73: { id: 73, name: "Customer data platform", slug: "customer-data-platform" },
  74: { id: 74, name: "Loyalty & rewards", slug: "loyalty-rewards" },
  75: { id: 75, name: "Feature management", slug: "feature-management" },
  76: { id: 76, name: "Consent management", slug: "consent-management" },
  77: { id: 77, name: "Email", slug: "email" },
  78: { id: 78, name: "Survey", slug: "survey" },
  79: { id: 79, name: "Cross-border ecommerce", slug: "cross-border-ecommerce" },
  80: { id: 80, name: "Referral marketing", slug: "referral-marketing" },
  81: { id: 81, name: "Pop-up", slug: "pop-up" },
  82: { id: 82, name: "DXP", slug: "dxp" },
  83: { id: 83, name: "Headless CMS", slug: "headless-cms" },
  84: { id: 84, name: "Page builder", slug: "page-builder" },
  85: { id: 85, name: "Shopify app", slug: "shopify-app" },
  86: { id: 86, name: "WordPress plugin", slug: "wordpress-plugin" },
  87: { id: 87, name: "CSS framework", slug: "css-framework" },
  88: { id: 88, name: "Browser fingerprinting", slug: "browser-fingerprinting" },
  89: { id: 89, name: "Ticket system", slug: "ticket-system" },
  90: { id: 90, name: "Scheduling", slug: "scheduling" },
  91: { id: 91, name: "Business intelligence", slug: "business-intelligence" },
  92: { id: 92, name: "Content curation", slug: "content-curation" },
  93: { id: 93, name: "Domain parking", slug: "domain-parking" },
  94: { id: 94, name: "WordPress theme", slug: "wordpress-theme" },
  95: { id: 95, name: "Authentication", slug: "authentication" },
  96: { id: 96, name: "Cart abandonment", slug: "cart-abandonment" },
  97: { id: 97, name: "Shipping", slug: "shipping" },
  98: { id: 98, name: "Appointment scheduling", slug: "appointment-scheduling" },
  99: { id: 99, name: "Social login", slug: "social-login" },
  100: { id: 100, name: "Product recommendation", slug: "product-recommendation" },
  101: { id: 101, name: "Conversion optimisation", slug: "conversion-optimisation" },
  102: { id: 102, name: "Form builder", slug: "form-builder" },
  103: { id: 103, name: "Search provider", slug: "search-provider" },
  104: { id: 104, name: "Social sharing", slug: "social-sharing" },
  105: { id: 105, name: "Wishlist", slug: "wishlist" },
  106: { id: 106, name: "Image optimiser", slug: "image-optimiser" },
  107: { id: 107, name: "Affiliate program", slug: "affiliate-program" },
  108: { id: 108, name: "Product reviews", slug: "product-reviews" },
  109: { id: 109, name: "JavaScript graphics", slug: "javascript-graphics" },
  110: { id: 110, name: "Multi-vendor marketplace", slug: "multi-vendor-marketplace" },
};

// --- Curated Top-200 Fingerprint Database ---
// Each entry follows the fingerprint schema declared above
// Patterns use \\;confidence:N and \\;version:\\1 syntax

const FINGERPRINT_DB: Record<string, Omit<TechnologyFingerprint, "name">> = {
  // --- JavaScript Frameworks ---
  "React": {
    cats: [12],
    js: { "React.version": "\\;version:\\1" },
    website: "https://reactjs.org",
    implies: "JavaScript",
  },
  "Vue.js": {
    cats: [12],
    js: { "Vue.version": "\\;version:\\1" },
    meta: { "generator": "Vue\\.js" },
    website: "https://vuejs.org",
    implies: "JavaScript",
  },
  "Angular": {
    cats: [12],
    html: '<[^>]*ng-version="([\\d.]+)"\\;version:\\1',
    js: { "angular.version.full": "\\;version:\\1" },
    website: "https://angular.io",
    implies: "JavaScript",
  },
  "AngularJS": {
    cats: [12],
    js: { "angular.version.full": "\\;version:\\1" },
    html: '<[^>]*ng-app[>= ]',
    website: "https://angularjs.org",
    excludes: "Angular",
    implies: "JavaScript",
  },
  "jQuery": {
    cats: [25],
    js: { "jQuery.fn.jquery": "\\;version:\\1" },
    scriptSrc: ["jquery[.-]([\\d.]+)(?:\\.min)?\\.js\\;version:\\1", "jquery\\.js"],
    website: "https://jquery.com",
    implies: "JavaScript",
  },
  "jQuery UI": {
    cats: [25],
    js: { "jQuery.ui.version": "\\;version:\\1" },
    scriptSrc: "jquery-ui[.-]([\\d.]+)(?:\\.min)?\\.js\\;version:\\1",
    website: "https://jqueryui.com",
    implies: "jQuery",
  },
  "Backbone.js": {
    cats: [12],
    js: { "Backbone.VERSION": "\\;version:\\1" },
    scriptSrc: "backbone[.-]([\\d.]+)(?:\\.min)?\\.js\\;version:\\1",
    website: "https://backbonejs.org",
    implies: ["Underscore.js", "JavaScript"],
  },
  "Ember.js": {
    cats: [12],
    js: { "Ember.VERSION": "\\;version:\\1" },
    html: '<[^>]*id="ember',
    website: "https://emberjs.com",
    implies: "JavaScript",
  },
  "Svelte": {
    cats: [12],
    html: '<[^>]*class="svelte-',
    js: { "__svelte_meta": "" },
    website: "https://svelte.dev",
    implies: "JavaScript",
  },
  "Preact": {
    cats: [12],
    js: { "__PREACT_DEVTOOLS__": "" },
    website: "https://preactjs.com",
    implies: "JavaScript",
  },
  "Alpine.js": {
    cats: [12],
    html: '<[^>]*x-data[= ]',
    js: { "Alpine.version": "\\;version:\\1" },
    scriptSrc: "alpine(?:\\.min)?\\.js",
    website: "https://alpinejs.dev",
  },
  "HTMX": {
    cats: [12],
    html: '<[^>]*hx-(?:get|post|put|delete|trigger)[= ]',
    js: { "htmx.version": "\\;version:\\1" },
    website: "https://htmx.org",
  },
  "Stimulus": {
    cats: [12],
    html: '<[^>]*data-controller[= ]',
    website: "https://stimulus.hotwired.dev",
    implies: "JavaScript",
  },
  "Lit": {
    cats: [12],
    js: { "litElementVersions": "" },
    website: "https://lit.dev",
    implies: "JavaScript",
  },
  "Solid": {
    cats: [12],
    js: { "_$HY": "" },
    website: "https://www.solidjs.com",
    implies: "JavaScript",
  },
  "Knockout": {
    cats: [12],
    js: { "ko.version": "\\;version:\\1" },
    website: "https://knockoutjs.com",
    implies: "JavaScript",
  },
  "Polymer": {
    cats: [12],
    js: { "Polymer.version": "\\;version:\\1" },
    website: "https://polymer-library.polymer-project.org",
    implies: "JavaScript",
  },
  "Mithril": {
    cats: [12],
    js: { "m.version": "\\;version:\\1" },
    scriptSrc: "mithril(?:\\.min)?\\.js",
    website: "https://mithril.js.org",
    implies: "JavaScript",
  },
  "Inferno": {
    cats: [12],
    js: { "Inferno.version": "\\;version:\\1" },
    website: "https://infernojs.org",
    implies: "JavaScript",
  },
  "Riot": {
    cats: [12],
    js: { "riot.version": "\\;version:\\1" },
    website: "https://riot.js.org",
    implies: "JavaScript",
  },
  "Marko": {
    cats: [12],
    html: '<[^>]*data-marko',
    js: { "markoComponent": "" },
    website: "https://markojs.com",
    implies: "JavaScript",
  },
  "Stencil": {
    cats: [12],
    html: '<[^>]*s-id[= ]',
    website: "https://stenciljs.com",
    implies: "JavaScript",
  },

  // --- Meta-frameworks ---
  "Next.js": {
    cats: [12, 18],
    js: { "__NEXT_DATA__": "" },
    html: ['<div id="__next"', 'script[^>]*/_next/'],
    meta: { "generator": "Next\\.js\\s([\\d.]+)\\;version:\\1" },
    website: "https://nextjs.org",
    implies: "React",
  },
  "Nuxt.js": {
    cats: [12, 18],
    js: { "__NUXT__": "", "__nuxt": "" },
    html: '<div id="__nuxt"',
    meta: { "generator": "Nuxt" },
    website: "https://nuxtjs.org",
    implies: "Vue.js",
  },
  "Gatsby": {
    cats: [12, 53],
    js: { "___gatsby": "" },
    html: '<div id="___gatsby"',
    meta: { "generator": "Gatsby\\s([\\d.]+)\\;version:\\1" },
    website: "https://www.gatsbyjs.com",
    implies: "React",
  },
  "SvelteKit": {
    cats: [12, 18],
    js: { "__sveltekit": "" },
    website: "https://kit.svelte.dev",
    implies: "Svelte",
  },
  "Remix": {
    cats: [12, 18],
    js: { "__remixContext": "" },
    website: "https://remix.run",
    implies: "React",
  },
  "Astro": {
    cats: [12, 53],
    html: '<astro-island',
    meta: { "generator": "Astro\\sv?([\\d.]+)\\;version:\\1" },
    website: "https://astro.build",
  },
  "Qwik": {
    cats: [12],
    html: '<[^>]*q:container',
    website: "https://qwik.dev",
    implies: "JavaScript",
  },

  // --- CSS Frameworks ---
  "Bootstrap": {
    cats: [59],
    html: '<link[^>]*bootstrap(?:\\.min)?\\.css',
    js: { "bootstrap.Alert.VERSION": "\\;version:\\1" },
    scriptSrc: "bootstrap(?:\\.min)?\\.js",
    website: "https://getbootstrap.com",
    implies: "JavaScript",
  },
  "Tailwind CSS": {
    cats: [87],
    html: '<link[^>]*tailwind',
    css: "tailwindcss",
    website: "https://tailwindcss.com",
  },
  "Foundation": {
    cats: [59],
    js: { "Foundation.version": "\\;version:\\1" },
    html: '<link[^>]*foundation(?:\\.min)?\\.css',
    website: "https://get.foundation",
  },
  "Bulma": {
    cats: [59],
    html: '<link[^>]*bulma(?:\\.min)?\\.css',
    website: "https://bulma.io",
  },
  "Materialize CSS": {
    cats: [59],
    html: '<link[^>]*materialize(?:\\.min)?\\.css',
    js: { "Materialize.version": "\\;version:\\1" },
    website: "https://materializecss.com",
  },
  "Semantic UI": {
    cats: [59],
    html: '<link[^>]*semantic(?:\\.min)?\\.css',
    website: "https://semantic-ui.com",
  },

  // --- CMS ---
  "WordPress": {
    cats: [1, 11],
    html: ['<link[^>]*wp-content', '<script[^>]*wp-includes'],
    meta: { "generator": "WordPress\\s?([\\d.]+)?\\;version:\\1" },
    headers: { "X-Powered-By": "WordPress" },
    cookies: { "wp-settings-": "" },
    js: { "wp": "" },
    website: "https://wordpress.org",
    implies: ["PHP", "MySQL"],
    excludes: ["Joomla", "Drupal"],
  },
  "Drupal": {
    cats: [1],
    js: { "Drupal.behaviors": "" },
    html: '<[^>]*drupal',
    headers: { "X-Generator": "Drupal\\s([\\d.]+)\\;version:\\1", "X-Drupal-Cache": "" },
    meta: { "generator": "Drupal\\s([\\d.]+)\\;version:\\1" },
    website: "https://www.drupal.org",
    implies: "PHP",
    excludes: ["WordPress", "Joomla"],
  },
  "Joomla": {
    cats: [1],
    js: { "Joomla": "" },
    meta: { "generator": "Joomla!?\\s([\\d.]+)\\;version:\\1" },
    headers: { "X-Content-Powered-By": "Joomla" },
    website: "https://www.joomla.org",
    implies: "PHP",
    excludes: ["WordPress", "Drupal"],
  },
  "Ghost": {
    cats: [1, 11],
    meta: { "generator": "Ghost\\s([\\d.]+)\\;version:\\1" },
    headers: { "X-Ghost-Cache-Status": "" },
    website: "https://ghost.org",
    implies: "Node.js",
  },
  "Contentful": {
    cats: [83],
    html: '<[^>]*contentful',
    meta: { "generator": "Contentful" },
    website: "https://www.contentful.com",
  },
  "Strapi": {
    cats: [83],
    headers: { "X-Powered-By": "Strapi" },
    website: "https://strapi.io",
    implies: "Node.js",
  },
  "Prismic": {
    cats: [83],
    html: '<[^>]*prismic',
    scriptSrc: "prismic\\.io",
    website: "https://prismic.io",
  },
  "Sanity": {
    cats: [83],
    scriptSrc: "sanity\\.io",
    website: "https://www.sanity.io",
  },
  "Hugo": {
    cats: [53],
    meta: { "generator": "Hugo\\s([\\d.]+)\\;version:\\1" },
    website: "https://gohugo.io",
  },
  "Jekyll": {
    cats: [53],
    meta: { "generator": "Jekyll\\sv?([\\d.]+)\\;version:\\1" },
    html: 'Powered by <a[^>]*jekyllrb',
    website: "https://jekyllrb.com",
  },
  "Hexo": {
    cats: [53, 11],
    meta: { "generator": "Hexo\\s([\\d.]+)\\;version:\\1" },
    website: "https://hexo.io",
  },
  "Eleventy": {
    cats: [53],
    meta: { "generator": "Eleventy\\sv?([\\d.]+)\\;version:\\1" },
    website: "https://www.11ty.dev",
  },
  "Docusaurus": {
    cats: [4, 53],
    js: { "__DOCUSAURUS_INSERT_BASEURL_BANNER": "" },
    meta: { "generator": "Docusaurus\\sv?([\\d.]+)\\;version:\\1" },
    website: "https://docusaurus.io",
    implies: "React",
  },
  "VuePress": {
    cats: [53],
    js: { "__VUEPRESS__": "" },
    meta: { "generator": "VuePress\\s([\\d.]+)\\;version:\\1" },
    website: "https://vuepress.vuejs.org",
    implies: "Vue.js",
  },
  "Pelican": {
    cats: [53, 11],
    meta: { "generator": "Pelican" },
    website: "https://getpelican.com",
    implies: "Python",
  },
  "Middleman": {
    cats: [53],
    meta: { "generator": "Middleman" },
    website: "https://middlemanapp.com",
    implies: "Ruby",
  },

  // --- E-commerce ---
  "Shopify": {
    cats: [6],
    js: { "Shopify.shop": "" },
    html: '<link[^>]*cdn\\.shopify\\.com',
    headers: { "X-ShopId": "", "X-Shopify-Stage": "" },
    cookies: { "_shopify_s": "" },
    website: "https://www.shopify.com",
  },
  "WooCommerce": {
    cats: [6],
    html: ['<[^>]*woocommerce', '<link[^>]*woocommerce'],
    js: { "woocommerce_params": "" },
    meta: { "generator": "WooCommerce\\s([\\d.]+)\\;version:\\1" },
    website: "https://woocommerce.com",
    implies: "WordPress",
  },
  "Magento": {
    cats: [6],
    js: { "Mage": "" },
    html: '<script[^>]*text/x-magento',
    cookies: { "frontend": "\\;confidence:50" },
    headers: { "X-Magento-Vary": "" },
    website: "https://magento.com",
    implies: "PHP",
  },
  "PrestaShop": {
    cats: [6],
    js: { "prestashop": "" },
    meta: { "generator": "PrestaShop" },
    headers: { "Powered-By": "PrestaShop" },
    cookies: { "PrestaShop-": "" },
    website: "https://www.prestashop.com",
    implies: "PHP",
  },
  "BigCommerce": {
    cats: [6],
    html: '<link[^>]*bigcommerce\\.com',
    js: { "bigcommerce_config": "" },
    website: "https://www.bigcommerce.com",
  },
  "OpenCart": {
    cats: [6],
    html: '<link[^>]*opencart',
    cookies: { "OCSESSID": "" },
    website: "https://www.opencart.com",
    implies: "PHP",
  },
  "Squarespace": {
    cats: [1, 6],
    js: { "Squarespace": "" },
    html: '<!-- This is Squarespace',
    cookies: { "SS_MID": "" },
    website: "https://www.squarespace.com",
  },
  "Wix": {
    cats: [1, 6],
    js: { "wixBiSession": "" },
    html: '<[^>]*wix\\.com',
    meta: { "generator": "Wix\\.com" },
    website: "https://www.wix.com",
  },
  "Weebly": {
    cats: [1, 6],
    js: { "_W.configDomain": "" },
    html: '<[^>]*editmysite\\.com',
    website: "https://www.weebly.com",
  },
  "Framer": {
    cats: [84],
    js: { "__framer_importFromPackage": "" },
    website: "https://www.framer.com",
  },
  "Bubble": {
    cats: [84],
    js: { "_bubble_page_load_data": "" },
    website: "https://bubble.io",
  },
  "Webflow": {
    cats: [1, 84],
    html: '<[^>]*data-wf-site',
    meta: { "generator": "Webflow" },
    js: { "Webflow": "" },
    website: "https://webflow.com",
  },
  "Tilda": {
    cats: [1, 84],
    scriptSrc: "tildacdn\\.com",
    html: '<[^>]*tildacdn',
    website: "https://tilda.cc",
  },
  "Duda": {
    cats: [1, 84],
    js: { "SystemID": "\\;confidence:50" },
    scriptSrc: "multiscreensite\\.com",
    website: "https://www.duda.co",
  },
  "GoDaddy Website Builder": {
    cats: [1, 84],
    meta: { "generator": "GoDaddy" },
    cookies: { "dps_site_id": "" },
    website: "https://www.godaddy.com",
  },

  // --- Web Servers ---
  "Nginx": {
    cats: [22],
    headers: { "Server": "nginx(?:/([\\d.]+))?\\;version:\\1" },
    website: "https://nginx.org",
  },
  "Apache": {
    cats: [22],
    headers: { "Server": "Apache(?:/([\\d.]+))?\\;version:\\1" },
    website: "https://httpd.apache.org",
  },
  "Microsoft IIS": {
    cats: [22],
    headers: { "Server": "Microsoft-IIS(?:/([\\d.]+))?\\;version:\\1" },
    website: "https://www.iis.net",
    implies: "Windows Server",
  },
  "LiteSpeed": {
    cats: [22],
    headers: { "Server": "LiteSpeed" },
    website: "https://www.litespeedtech.com",
  },
  "Caddy": {
    cats: [22],
    headers: { "Server": "Caddy" },
    website: "https://caddyserver.com",
  },

  // --- Programming Languages ---
  "PHP": {
    cats: [27],
    headers: { "X-Powered-By": "PHP/?([\\d.]+)?\\;version:\\1", "Server": "php/?([\\d.]+)?\\;version:\\1" },
    cookies: { "PHPSESSID": "" },
    website: "https://www.php.net",
  },
  "Python": {
    cats: [27],
    headers: { "X-Powered-By": "Python", "Server": "Python" },
    website: "https://www.python.org",
  },
  "Ruby": {
    cats: [27],
    headers: { "X-Powered-By": "Phusion Passenger", "Server": "Phusion Passenger" },
    website: "https://www.ruby-lang.org",
  },
  "Java": {
    cats: [27],
    headers: { "X-Powered-By": "(?:JSP|Servlet|Java)" },
    cookies: { "JSESSIONID": "" },
    website: "https://www.java.com",
  },
  "Node.js": {
    cats: [27],
    headers: { "X-Powered-By": "Express\\;implies:Express" },
    website: "https://nodejs.org",
    implies: "JavaScript",
  },
  "JavaScript": {
    cats: [27],
    website: "https://developer.mozilla.org",
  },
  "ASP.NET": {
    cats: [18],
    headers: { "X-Powered-By": "ASP\\.NET", "X-AspNet-Version": "([\\d.]+)\\;version:\\1" },
    cookies: { "ASP.NET_SessionId": "", "ASPSESSIONID": "" },
    website: "https://dotnet.microsoft.com",
  },

  // --- Web Frameworks ---
  "Express": {
    cats: [18],
    headers: { "X-Powered-By": "Express" },
    website: "https://expressjs.com",
    implies: "Node.js",
  },
  "Laravel": {
    cats: [18],
    cookies: { "laravel_session": "" },
    html: '<input[^>]*name="_token"',
    js: { "Laravel": "" },
    website: "https://laravel.com",
    implies: "PHP",
  },
  "Django": {
    cats: [18],
    html: '<input[^>]*name="csrfmiddlewaretoken"',
    cookies: { "csrftoken": "", "django_language": "" },
    js: { "django": "" },
    website: "https://www.djangoproject.com",
    implies: "Python",
  },
  "Ruby on Rails": {
    cats: [18],
    html: '<meta[^>]*name="csrf-param"[^>]*content="authenticity_token"',
    headers: { "X-Powered-By": "Phusion Passenger" },
    cookies: { "_session_id": "\\;confidence:50" },
    website: "https://rubyonrails.org",
    implies: "Ruby",
  },
  "Flask": {
    cats: [18],
    headers: { "Server": "Werkzeug" },
    website: "https://flask.palletsprojects.com",
    implies: "Python",
  },
  "FastAPI": {
    cats: [18],
    headers: { "Server": "uvicorn" },
    website: "https://fastapi.tiangolo.com",
    implies: "Python",
  },
  "Spring": {
    cats: [18],
    headers: { "X-Application-Context": "" },
    cookies: { "JSESSIONID": "\\;confidence:50" },
    website: "https://spring.io",
    implies: "Java",
  },
  "Symfony": {
    cats: [18],
    cookies: { "sf_redirect": "" },
    headers: { "X-Debug-Token": "" },
    website: "https://symfony.com",
    implies: "PHP",
  },
  "CodeIgniter": {
    cats: [18],
    cookies: { "ci_session": "" },
    headers: { "X-Powered-By": "CodeIgniter" },
    website: "https://codeigniter.com",
    implies: "PHP",
  },
  "CakePHP": {
    cats: [18],
    cookies: { "cakephp": "" },
    meta: { "generator": "CakePHP" },
    website: "https://cakephp.org",
    implies: "PHP",
  },

  // --- Analytics ---
  "Google Analytics": {
    cats: [10],
    scriptSrc: ["google-analytics\\.com/(?:ga|analytics|urchin)\\.js", "googletagmanager\\.com/gtag/"],
    js: { "GoogleAnalyticsObject": "", "ga.getAll": "" },
    html: "google-analytics\\.com/ga\\.js",
    website: "https://marketingplatform.google.com/about/analytics/",
  },
  "Google Tag Manager": {
    cats: [42],
    scriptSrc: "googletagmanager\\.com/gtm\\.js",
    html: "<!-- Google Tag Manager",
    js: { "google_tag_manager": "" },
    website: "https://marketingplatform.google.com/about/tag-manager/",
  },
  "Hotjar": {
    cats: [10],
    scriptSrc: "static\\.hotjar\\.com",
    js: { "hj": "" },
    website: "https://www.hotjar.com",
  },
  "Mixpanel": {
    cats: [10],
    scriptSrc: "cdn\\.mxpnl\\.com",
    js: { "mixpanel": "" },
    website: "https://mixpanel.com",
  },
  "Segment": {
    cats: [10],
    scriptSrc: "cdn\\.segment\\.com",
    js: { "analytics.identify": "" },
    website: "https://segment.com",
  },
  "Heap": {
    cats: [10],
    scriptSrc: "cdn\\.heapanalytics\\.com",
    js: { "heap.track": "" },
    website: "https://www.heap.io",
  },
  "Amplitude": {
    cats: [10],
    scriptSrc: "cdn\\.amplitude\\.com",
    js: { "amplitude.getInstance": "" },
    website: "https://amplitude.com",
  },
  "Plausible": {
    cats: [10],
    scriptSrc: "plausible\\.io",
    website: "https://plausible.io",
  },
  "Matomo": {
    cats: [10],
    js: { "_paq": "", "Matomo": "" },
    scriptSrc: ["matomo\\.js", "piwik\\.js"],
    website: "https://matomo.org",
    implies: "PHP",
  },
  "Fathom Analytics": {
    cats: [10],
    scriptSrc: "cdn\\.usefathom\\.com",
    website: "https://usefathom.com",
  },
  "PostHog": {
    cats: [10],
    scriptSrc: "us\\.posthog\\.com",
    js: { "posthog": "" },
    website: "https://posthog.com",
  },
  "FullStory": {
    cats: [10],
    scriptSrc: "fullstory\\.com",
    js: { "FS.identify": "" },
    website: "https://www.fullstory.com",
  },
  "Clarity": {
    cats: [10],
    scriptSrc: "clarity\\.ms",
    js: { "clarity": "" },
    website: "https://clarity.microsoft.com",
  },
  "Lucky Orange": {
    cats: [10],
    scriptSrc: "luckyorange\\.com",
    js: { "__lo_site_id": "" },
    website: "https://www.luckyorange.com",
  },

  // --- CDN & Hosting ---
  "Cloudflare": {
    cats: [31],
    headers: { "cf-ray": "", "Server": "cloudflare", "cf-cache-status": "" },
    js: { "CloudFlare": "" },
    website: "https://www.cloudflare.com",
  },
  "Amazon CloudFront": {
    cats: [31],
    headers: { "Via": "CloudFront", "X-Amz-Cf-Id": "", "X-Amz-Cf-Pop": "" },
    website: "https://aws.amazon.com/cloudfront/",
  },
  "Fastly": {
    cats: [31],
    headers: { "Via": "varnish", "X-Served-By": "cache-", "X-Fastly-Request-ID": "" },
    website: "https://www.fastly.com",
  },
  "Akamai": {
    cats: [31],
    headers: { "X-Akamai-Transformed": "", "Server": "AkamaiGHost" },
    website: "https://www.akamai.com",
  },
  "Vercel": {
    cats: [62, 66],
    headers: { "Server": "Vercel", "X-Vercel-Id": "", "X-Vercel-Cache": "" },
    website: "https://vercel.com",
  },
  "Netlify": {
    cats: [62, 66],
    headers: { "Server": "Netlify", "X-NF-Request-ID": "" },
    website: "https://www.netlify.com",
  },
  "GitHub Pages": {
    cats: [62, 66],
    headers: { "Server": "GitHub\\.com", "X-GitHub-Request-Id": "" },
    website: "https://pages.github.com",
  },
  "Heroku": {
    cats: [62, 66],
    headers: { "Via": "heroku", "Server": "heroku" },
    website: "https://www.heroku.com",
  },
  "AWS": {
    cats: [62],
    headers: { "X-Amzn-RequestId": "", "Server": "AmazonS3" },
    website: "https://aws.amazon.com",
  },
  "Google Cloud": {
    cats: [62],
    headers: { "Server": "Google Frontend", "Via": "google" },
    website: "https://cloud.google.com",
  },
  "Azure": {
    cats: [62],
    headers: { "X-Azure-Ref": "", "X-Powered-By": "ASP\\.NET" },
    website: "https://azure.microsoft.com",
  },
  "DigitalOcean": {
    cats: [62],
    headers: { "Server": "DigitalOcean" },
    website: "https://www.digitalocean.com",
  },
  "Firebase": {
    cats: [62],
    headers: { "X-Powered-By": "Express\\;confidence:25", "Server": "Google Frontend\\;confidence:25" },
    scriptSrc: "firebase(?:app)?(?:\\.min)?\\.js",
    js: { "firebase.SDK_VERSION": "\\;version:\\1" },
    website: "https://firebase.google.com",
  },
  "Supabase": {
    cats: [34],
    scriptSrc: "supabase",
    headers: { "X-Powered-By": "Supabase" },
    website: "https://supabase.com",
  },

  // --- Marketing & Live Chat ---
  "Intercom": {
    cats: [47],
    scriptSrc: "widget\\.intercom\\.io",
    js: { "Intercom": "" },
    website: "https://www.intercom.com",
  },
  "Drift": {
    cats: [47],
    scriptSrc: "js\\.driftt?\\.com",
    js: { "drift": "" },
    website: "https://www.drift.com",
  },
  "Zendesk Chat": {
    cats: [47],
    scriptSrc: ["static\\.zdassets\\.com", "ekr\\.zdassets\\.com"],
    js: { "zE": "" },
    website: "https://www.zendesk.com",
  },
  "Crisp": {
    cats: [47],
    scriptSrc: "client\\.crisp\\.chat",
    js: { "$crisp": "" },
    website: "https://crisp.chat",
  },
  "LiveChat": {
    cats: [47],
    scriptSrc: "cdn\\.livechatinc\\.com",
    js: { "LiveChatWidget": "" },
    website: "https://www.livechat.com",
  },
  "Tawk.to": {
    cats: [47],
    scriptSrc: "embed\\.tawk\\.to",
    js: { "Tawk_API": "" },
    website: "https://www.tawk.to",
  },
  "HubSpot": {
    cats: [32],
    scriptSrc: "js\\.hs-scripts\\.com",
    js: { "_hsq": "" },
    website: "https://www.hubspot.com",
  },
  "Mailchimp": {
    cats: [32],
    scriptSrc: "chimpstatic\\.com",
    html: '<form[^>]*list-manage\\.com',
    website: "https://mailchimp.com",
  },
  "Klaviyo": {
    cats: [32, 77],
    scriptSrc: "static\\.klaviyo\\.com",
    js: { "_learnq": "" },
    website: "https://www.klaviyo.com",
  },
  "Marketo": {
    cats: [32],
    scriptSrc: "munchkin\\.marketo\\.net",
    js: { "Munchkin": "" },
    website: "https://www.marketo.com",
  },
  "Salesforce": {
    cats: [48],
    html: '<[^>]*force\\.com',
    scriptSrc: "force\\.com",
    website: "https://www.salesforce.com",
  },

  // --- Payment ---
  "Stripe": {
    cats: [41],
    scriptSrc: "js\\.stripe\\.com",
    js: { "Stripe": "" },
    website: "https://stripe.com",
  },
  "PayPal": {
    cats: [41],
    scriptSrc: "paypal(?:objects)?\\.com",
    js: { "paypal.Buttons": "" },
    website: "https://www.paypal.com",
  },
  "Braintree": {
    cats: [41],
    scriptSrc: "braintreegateway\\.com",
    js: { "braintree": "" },
    website: "https://www.braintreepayments.com",
  },
  "Square": {
    cats: [41],
    scriptSrc: "squareup\\.com",
    website: "https://squareup.com",
  },
  "Klarna": {
    cats: [41, 69],
    scriptSrc: "klarna\\.com",
    js: { "Klarna": "" },
    website: "https://www.klarna.com",
  },
  "Afterpay": {
    cats: [69],
    scriptSrc: "afterpay\\.com",
    js: { "Afterpay": "" },
    website: "https://www.afterpay.com",
  },

  // --- JavaScript Libraries ---
  "Underscore.js": {
    cats: [25],
    js: { "_.VERSION": "\\;version:\\1" },
    scriptSrc: "underscore(?:\\.min)?\\.js",
    website: "https://underscorejs.org",
  },
  "Lodash": {
    cats: [25],
    js: { "_.VERSION": "\\;version:\\1\\;confidence:50" },
    scriptSrc: "lodash(?:\\.min)?\\.js",
    website: "https://lodash.com",
  },
  "Moment.js": {
    cats: [25],
    js: { "moment.version": "\\;version:\\1" },
    scriptSrc: "moment(?:\\.min)?\\.js",
    website: "https://momentjs.com",
  },
  "D3": {
    cats: [25, 109],
    js: { "d3.version": "\\;version:\\1" },
    scriptSrc: "d3(?:\\.min)?\\.js",
    website: "https://d3js.org",
  },
  "Three.js": {
    cats: [25, 109],
    js: { "THREE.REVISION": "\\;version:\\1" },
    scriptSrc: "three(?:\\.min)?\\.js",
    website: "https://threejs.org",
  },
  "Chart.js": {
    cats: [25, 109],
    js: { "Chart.version": "\\;version:\\1" },
    scriptSrc: "chart(?:\\.min)?\\.js",
    website: "https://www.chartjs.org",
  },
  "Axios": {
    cats: [25],
    js: { "axios.defaults": "" },
    website: "https://axios-http.com",
  },
  "Socket.io": {
    cats: [25],
    scriptSrc: "socket\\.io(?:\\.min)?\\.js",
    js: { "io.connect": "" },
    website: "https://socket.io",
  },
  "Hammer.js": {
    cats: [25],
    js: { "Hammer.VERSION": "\\;version:\\1" },
    scriptSrc: "hammer(?:\\.min)?\\.js",
    website: "https://hammerjs.github.io",
  },
  "GSAP": {
    cats: [25],
    js: { "gsap.version": "\\;version:\\1" },
    scriptSrc: "gsap(?:\\.min)?\\.js",
    website: "https://gsap.com",
  },
  "Swiper": {
    cats: [25],
    js: { "Swiper": "" },
    scriptSrc: "swiper(?:-bundle)?(?:\\.min)?\\.js",
    website: "https://swiperjs.com",
  },
  "Lottie": {
    cats: [25],
    js: { "lottie": "" },
    scriptSrc: "lottie(?:\\.min)?\\.js",
    website: "https://airbnb.design/lottie/",
  },
  "AOS": {
    cats: [25],
    js: { "AOS": "" },
    html: '<[^>]*data-aos[= ]',
    scriptSrc: "aos(?:\\.min)?\\.js",
    website: "https://michalsnik.github.io/aos/",
  },
  "Turbo": {
    cats: [12],
    js: { "Turbo": "" },
    html: '<turbo-frame',
    website: "https://turbo.hotwired.dev",
  },

  // --- Security & Cookie Compliance ---
  "Cookiebot": {
    cats: [57, 76],
    scriptSrc: "consent\\.cookiebot\\.com",
    js: { "Cookiebot": "" },
    website: "https://www.cookiebot.com",
  },
  "OneTrust": {
    cats: [57, 76],
    scriptSrc: "cdn\\.cookielaw\\.org",
    js: { "OneTrust": "" },
    cookies: { "OptanonConsent": "" },
    website: "https://www.onetrust.com",
  },
  "CookieYes": {
    cats: [57, 76],
    scriptSrc: "cdn-cookieyes\\.com",
    website: "https://www.cookieyes.com",
  },
  "TrustArc": {
    cats: [57, 76],
    scriptSrc: "consent\\.trustarc\\.com",
    website: "https://trustarc.com",
  },
  "reCAPTCHA": {
    cats: [16],
    scriptSrc: "recaptcha",
    js: { "grecaptcha": "" },
    html: '<[^>]*g-recaptcha',
    website: "https://www.google.com/recaptcha/",
  },
  "hCaptcha": {
    cats: [16],
    scriptSrc: "hcaptcha\\.com",
    js: { "hcaptcha": "" },
    html: '<[^>]*h-captcha',
    website: "https://www.hcaptcha.com",
  },

  // --- A/B Testing & Feature Flags ---
  "Optimizely": {
    cats: [10, 65],
    scriptSrc: "optimizely\\.com",
    js: { "optimizely": "" },
    website: "https://www.optimizely.com",
  },
  "LaunchDarkly": {
    cats: [75],
    scriptSrc: "launchdarkly\\.com",
    js: { "LDClient": "" },
    website: "https://launchdarkly.com",
  },
  "VWO": {
    cats: [65],
    scriptSrc: "dev\\.visualwebsiteoptimizer\\.com",
    js: { "_vwo_code": "" },
    website: "https://vwo.com",
  },

  // --- SEO & Social ---
  "Yoast SEO": {
    cats: [50, 86],
    html: '<!-- This site is optimized with the Yoast SEO',
    meta: { "generator": "Yoast SEO" },
    website: "https://yoast.com",
    implies: "WordPress",
  },
  "Schema.org": {
    cats: [50],
    html: '<script[^>]*type="application/ld\\+json"',
    website: "https://schema.org",
  },
  "Open Graph": {
    cats: [19],
    meta: { "og:title": "" },
    html: '<meta[^>]*property="og:',
    website: "https://ogp.me",
  },
  "Twitter Cards": {
    cats: [19],
    meta: { "twitter:card": "" },
    website: "https://developer.twitter.com/en/docs/twitter-for-websites/cards",
  },

  // --- Fonts ---
  "Google Fonts": {
    cats: [17],
    html: '<link[^>]*fonts\\.googleapis\\.com',
    scriptSrc: "fonts\\.googleapis\\.com",
    css: "fonts\\.googleapis\\.com",
    website: "https://fonts.google.com",
  },
  "Adobe Fonts": {
    cats: [17],
    scriptSrc: "use\\.typekit\\.net",
    html: '<link[^>]*use\\.typekit\\.net',
    website: "https://fonts.adobe.com",
  },
  "Font Awesome": {
    cats: [17],
    html: ['<link[^>]*font-awesome', '<[^>]*class="fa[sr]? fa-'],
    scriptSrc: "fontawesome",
    website: "https://fontawesome.com",
  },

  // --- Video ---
  "YouTube": {
    cats: [14],
    html: '<iframe[^>]*youtube\\.com',
    scriptSrc: "youtube\\.com",
    website: "https://www.youtube.com",
  },
  "Vimeo": {
    cats: [14],
    html: '<iframe[^>]*vimeo\\.com',
    scriptSrc: "vimeo\\.com",
    website: "https://vimeo.com",
  },
  "Wistia": {
    cats: [14],
    scriptSrc: "fast\\.wistia\\.com",
    js: { "Wistia": "" },
    website: "https://wistia.com",
  },

  // --- RUM & Performance ---
  "New Relic": {
    cats: [10, 55],
    scriptSrc: "js-agent\\.newrelic\\.com",
    js: { "NREUM": "" },
    website: "https://newrelic.com",
  },
  "Datadog RUM": {
    cats: [55],
    scriptSrc: "datadog-rum",
    js: { "DD_RUM": "" },
    website: "https://www.datadoghq.com",
  },
  "Sentry": {
    cats: [55],
    scriptSrc: "browser\\.sentry-cdn\\.com",
    js: { "Sentry.init": "" },
    website: "https://sentry.io",
  },
  "SpeedCurve": {
    cats: [55, 70],
    scriptSrc: "cdn\\.speedcurve\\.com",
    js: { "LUX": "" },
    website: "https://www.speedcurve.com",
  },
  "Dynatrace": {
    cats: [55],
    scriptSrc: "js-cdn\\.dynatrace\\.com",
    js: { "dtrum": "" },
    website: "https://www.dynatrace.com",
  },

  // --- Maps ---
  "Google Maps": {
    cats: [35],
    scriptSrc: "maps\\.googleapis\\.com",
    js: { "google.maps": "" },
    website: "https://developers.google.com/maps",
  },
  "Mapbox": {
    cats: [35],
    scriptSrc: "api\\.mapbox\\.com",
    js: { "mapboxgl": "" },
    website: "https://www.mapbox.com",
  },
  "Leaflet": {
    cats: [35],
    js: { "L.version": "\\;version:\\1" },
    html: '<link[^>]*leaflet(?:\\.min)?\\.css',
    website: "https://leafletjs.com",
  },

  // --- Caching ---
  "Varnish": {
    cats: [23],
    headers: { "Via": "varnish", "X-Varnish": "" },
    website: "https://varnish-cache.org",
  },
  "Redis": {
    cats: [34],
    website: "https://redis.io",
  },

  // --- Reverse Proxy ---
  "Amazon ALB": {
    cats: [63],
    headers: { "Server": "awselb" },
    cookies: { "AWSALB": "" },
    website: "https://aws.amazon.com/elasticloadbalancing/",
  },

  // --- Image Optimization ---
  "Cloudinary": {
    cats: [106],
    html: '<[^>]*cloudinary\\.com',
    scriptSrc: "cloudinary",
    website: "https://cloudinary.com",
  },
  "Imgix": {
    cats: [106],
    html: '<[^>]*imgix\\.net',
    website: "https://imgix.com",
  },

  // --- Authentication ---
  "Auth0": {
    cats: [95],
    scriptSrc: "auth0\\.com",
    js: { "auth0": "" },
    website: "https://auth0.com",
  },
  "Okta": {
    cats: [95],
    scriptSrc: "okta\\.com",
    website: "https://www.okta.com",
  },
  "Clerk": {
    cats: [95],
    scriptSrc: "clerk\\.com",
    js: { "Clerk": "" },
    website: "https://clerk.com",
  },

  // --- Search ---
  "Algolia": {
    cats: [29],
    scriptSrc: "algoliasearch",
    js: { "algoliasearch": "" },
    website: "https://www.algolia.com",
  },
  "Elasticsearch": {
    cats: [29],
    headers: { "X-Elastic-Product": "Elasticsearch" },
    website: "https://www.elastic.co",
  },

  // --- Misc ---
  "Webpack": {
    cats: [19],
    js: { "webpackJsonp": "", "webpackChunk": "" },
    website: "https://webpack.js.org",
  },
  "Vite": {
    cats: [19],
    html: '<script[^>]*/@vite',
    website: "https://vitejs.dev",
    implies: "JavaScript",
  },
  "Parcel": {
    cats: [19],
    html: '<script[^>]*parcel',
    website: "https://parceljs.org",
  },
  "TypeScript": {
    cats: [27],
    website: "https://www.typescriptlang.org",
    implies: "JavaScript",
  },
  "GraphQL": {
    cats: [19],
    html: '<[^>]*graphql',
    website: "https://graphql.org",
  },
  "PWA": {
    cats: [19],
    html: '<link[^>]*rel="manifest"',
    website: "https://web.dev/progressive-web-apps/",
  },
  "AMP": {
    cats: [19],
    html: ['<html[^>]*\\samp[\\s>]', '<html[^>]*\\u26A1'],
    website: "https://amp.dev",
  },
  "Windows Server": {
    cats: [22],
    headers: { "Server": "Microsoft" },
    website: "https://www.microsoft.com/windows-server",
  },
  "MySQL": {
    cats: [34],
    website: "https://www.mysql.com",
  },

  // --- Advertising ---
  "Google AdSense": {
    cats: [36],
    scriptSrc: "pagead2\\.googlesyndication\\.com",
    html: '<ins[^>]*class="adsbygoogle"',
    website: "https://www.google.com/adsense",
  },
  "Google Ads": {
    cats: [36],
    scriptSrc: "googleads\\.g\\.doubleclick\\.net",
    website: "https://ads.google.com",
  },
  "Facebook Pixel": {
    cats: [10, 36],
    scriptSrc: "connect\\.facebook\\.net",
    js: { "fbq": "" },
    website: "https://www.facebook.com/business/tools/meta-pixel",
  },
  "Twitter Pixel": {
    cats: [10, 36],
    scriptSrc: "static\\.ads-twitter\\.com",
    js: { "twq": "" },
    website: "https://business.twitter.com",
  },
  "LinkedIn Insight Tag": {
    cats: [10, 36],
    scriptSrc: "snap\\.licdn\\.com",
    js: { "_linkedin_data_partner_ids": "" },
    website: "https://business.linkedin.com",
  },
  "TikTok Pixel": {
    cats: [10, 36],
    scriptSrc: "analytics\\.tiktok\\.com",
    js: { "ttq": "" },
    website: "https://ads.tiktok.com",
  },
  "Pinterest Tag": {
    cats: [10, 36],
    scriptSrc: "pintrk",
    js: { "pintrk": "" },
    website: "https://business.pinterest.com",
  },

  // --- Reviews ---
  "Trustpilot": {
    cats: [68],
    scriptSrc: "widget\\.trustpilot\\.com",
    html: '<[^>]*trustpilot',
    website: "https://www.trustpilot.com",
  },
  "Bazaarvoice": {
    cats: [68],
    scriptSrc: "bazaarvoice\\.com",
    js: { "BV": "" },
    website: "https://www.bazaarvoice.com",
  },
  "Yotpo": {
    cats: [68, 108],
    scriptSrc: "staticw2\\.yotpo\\.com",
    js: { "yotpo": "" },
    website: "https://www.yotpo.com",
  },
  "Judge.me": {
    cats: [68, 108],
    scriptSrc: "judgeme\\.imgix\\.net",
    website: "https://judge.me",
  },

  // --- Forms ---
  "Typeform": {
    cats: [102],
    scriptSrc: "embed\\.typeform\\.com",
    html: '<[^>]*typeform',
    website: "https://www.typeform.com",
  },
  "JotForm": {
    cats: [102],
    scriptSrc: "cdn\\.jotfor\\.ms",
    html: '<[^>]*jotform',
    website: "https://www.jotform.com",
  },

  // --- Scheduling ---
  "Calendly": {
    cats: [90],
    scriptSrc: "calendly\\.com",
    html: '<[^>]*calendly',
    website: "https://calendly.com",
  },

  // --- Accessibility ---
  "AccessiBe": {
    cats: [58],
    scriptSrc: "acsbapp\\.com",
    js: { "acsbJS": "" },
    website: "https://accessibe.com",
  },
  "UserWay": {
    cats: [58],
    scriptSrc: "userway\\.org",
    js: { "UserWay": "" },
    website: "https://userway.org",
  },
};

// --- Compiled Technology Database ---

interface CompiledTechnology {
  name: string;
  cats: number[];
  website?: string;
  icon?: string;
  implies: TechRelationship[];
  excludes: TechRelationship[];
  patterns: {
    type: string;
    key?: string;
    compiled: CompiledPattern;
  }[];
}

let compiledDB: CompiledTechnology[] | null = null;

function compilePatternEntry(
  type: string,
  key: string | undefined,
  raw: string
): { type: string; key?: string; compiled: CompiledPattern } {
  return { type, key, compiled: parsePattern(raw) };
}

function compileStringOrArray(
  type: string,
  value: string | string[]
): { type: string; key?: string; compiled: CompiledPattern }[] {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => compilePatternEntry(type, undefined, v));
}

function compileRecord(
  type: string,
  value: Record<string, string>,
  caseSensitive = false
): { type: string; key?: string; compiled: CompiledPattern }[] {
  return Object.entries(value).map(([key, pattern]) =>
    compilePatternEntry(type, caseSensitive ? key : key.toLowerCase(), pattern)
  );
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse an implies/excludes entry into a TechRelationship.
 * Supports: "React" (weight 100) or "React\\;confidence:50" (weight 50)
 */
function parseRelationship(entry: string): TechRelationship {
  const parts = entry.split("\\;");
  const name = parts[0].trim();
  let confidence = 100;
  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(":");
    if (colonIdx > 0) {
      const key = parts[i].substring(0, colonIdx);
      const val = parts[i].substring(colonIdx + 1);
      if (key === "confidence") {
        const parsed = parseInt(val, 10);
        confidence = isNaN(parsed) ? 100 : parsed;
      }
    }
  }
  return { name, confidence };
}

/**
 * Compile the fingerprint DB at load time. Called once, cached.
 */
function compileDB(): CompiledTechnology[] {
  if (compiledDB) return compiledDB;

  compiledDB = Object.entries(FINGERPRINT_DB).map(([name, fp]) => {
    const patterns: CompiledTechnology["patterns"] = [];

    if (fp.headers) patterns.push(...compileRecord("headers", fp.headers));
    if (fp.cookies) patterns.push(...compileRecord("cookies", fp.cookies));
    if (fp.js) patterns.push(...compileRecord("js", fp.js, true)); // JS property paths are case-sensitive
    if (fp.meta) patterns.push(...compileRecord("meta", fp.meta));
    if (fp.scriptSrc) patterns.push(...compileStringOrArray("scriptSrc", fp.scriptSrc));
    if (fp.html) patterns.push(...compileStringOrArray("html", fp.html));
    if (fp.css) patterns.push(...compileStringOrArray("css", fp.css));
    if (fp.url) patterns.push(...compileStringOrArray("url", fp.url));

    return {
      name,
      cats: fp.cats,
      website: fp.website,
      icon: fp.icon,
      implies: toStringArray(fp.implies).map(parseRelationship),
      excludes: toStringArray(fp.excludes).map(parseRelationship),
      patterns,
    };
  });

  return compiledDB;
}

// --- Relationship Graph Resolution ---

/**
 * Resolve transitive implies: if Next.js is detected, React and JavaScript surface automatically.
 * Confidence propagation: implier.confidence * (impliedWeight / 100).
 * Bounded traversal: max depth 10, visited set prevents cycles.
 * Implied detections tagged with "implied:<source>" in matchedSignals.
 */
export function resolveImplies(
  detections: TechDetection[],
  db: CompiledTechnology[]
): TechDetection[] {
  const MAX_DEPTH = 10;

  const detectionMap = new Map<string, TechDetection>();
  for (const d of detections) {
    detectionMap.set(d.name, { ...d, matchedSignals: [...d.matchedSignals] });
  }

  const techLookup = new Map<string, CompiledTechnology>();
  for (const t of db) {
    techLookup.set(t.name, t);
  }

  // Track applied relationship pairs to prevent re-boosting on subsequent iterations
  const appliedPairs = new Set<string>();

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let changed = false;
    const currentDetections = Array.from(detectionMap.values());

    for (const detection of currentDetections) {
      const compiled = techLookup.get(detection.name);
      if (!compiled) continue;

      for (const rel of compiled.implies) {
        const pairKey = `${detection.name}→${rel.name}`;
        if (appliedPairs.has(pairKey)) continue;
        appliedPairs.add(pairKey);

        const impliedCompiled = techLookup.get(rel.name);
        if (!impliedCompiled) continue;

        const propagatedConfidence = Math.round(
          detection.confidence * (rel.confidence / 100)
        );
        if (propagatedConfidence <= 0) continue;

        const existing = detectionMap.get(rel.name);
        if (existing) {
          // Always tag the relationship for transparency
          if (!existing.matchedSignals.includes(`implied:${detection.name}`)) {
            existing.matchedSignals.push(`implied:${detection.name}`);
          }
          const newConfidence = Math.min(100, existing.confidence + propagatedConfidence);
          if (newConfidence > existing.confidence) {
            existing.confidence = newConfidence;
            changed = true;
          }
        } else {
          detectionMap.set(rel.name, {
            name: rel.name,
            confidence: Math.min(100, propagatedConfidence),
            version: "",
            categories: impliedCompiled.cats
              .map((id) => CATEGORIES[id])
              .filter((c): c is TechnologyCategory => !!c),
            website: impliedCompiled.website,
            icon: impliedCompiled.icon,
            matchedSignals: [`implied:${detection.name}`],
          });
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  return Array.from(detectionMap.values());
}

/**
 * Remove mutually exclusive technologies from detections.
 * If WordPress is detected, Joomla and Drupal are removed.
 * Technologies processed in order — first detected technology wins.
 */
export function resolveExcludes(
  detections: TechDetection[],
  db: CompiledTechnology[]
): TechDetection[] {
  const techLookup = new Map<string, CompiledTechnology>();
  for (const t of db) {
    techLookup.set(t.name, t);
  }

  const excluded = new Set<string>();

  for (const detection of detections) {
    if (excluded.has(detection.name)) continue;

    const compiled = techLookup.get(detection.name);
    if (!compiled) continue;

    for (const rel of compiled.excludes) {
      excluded.add(rel.name);
    }
  }

  return detections.filter((d) => !excluded.has(d.name));
}

// --- Matcher ---

/**
 * Match captured signals against the fingerprint DB.
 * Additive confidence scoring: per-pattern weights summed, capped at 100.
 * Pipeline: pattern matching → resolveImplies → resolveExcludes.
 */
export function matchFingerprints(signals: CapturedSignals): TechDetection[] {
  const db = compileDB();

  const accumulator = new Map<
    string,
    { tech: CompiledTechnology; confidence: number; version: string; matchedSignals: string[] }
  >();

  for (const tech of db) {
    let totalConfidence = 0;
    let bestVersion = "";
    const matchedSignals: string[] = [];

    for (const pat of tech.patterns) {
      const matches = matchPattern(pat, signals);

      for (const m of matches) {
        totalConfidence += pat.compiled.confidence;
        matchedSignals.push(m.signal);

        // Version extraction
        if (pat.compiled.version && m.matchedValue) {
          let v: string;
          // For js existence checks (empty regex), the value IS the version
          const isEmptyRegex = pat.compiled.regex.source === "" || pat.compiled.regex.source === "(?:)";
          if (isEmptyRegex && pat.compiled.version === "\\1" && pat.type === "js") {
            v = m.matchedValue.trim();
          } else {
            v = resolveVersion(pat.compiled, m.matchedValue);
          }
          if (v && v.length > bestVersion.length && v.length <= 15) {
            const num = parseInt(v, 10);
            if (isNaN(num) || num < 10000) {
              bestVersion = v;
            }
          }
        }
      }
    }

    if (totalConfidence > 0) {
      accumulator.set(tech.name, {
        tech,
        confidence: Math.min(100, totalConfidence),
        version: bestVersion,
        matchedSignals,
      });
    }
  }

  const directDetections = Array.from(accumulator.values()).map(({ tech, confidence, version, matchedSignals }) => ({
    name: tech.name,
    confidence,
    version,
    categories: tech.cats
      .map((id) => CATEGORIES[id])
      .filter((c): c is TechnologyCategory => !!c),
    website: tech.website,
    icon: tech.icon,
    matchedSignals,
  }));

  // Pipeline: pattern matching → implies resolution → excludes resolution
  const withImplies = resolveImplies(directDetections, db);
  return resolveExcludes(withImplies, db);
}

interface PatternMatch {
  signal: string;
  matchedValue: string;
}

/** Case-insensitive key lookup for Record<string, string[]> */
function findCaseInsensitive(
  record: Record<string, string[]>,
  key: string
): string[] | undefined {
  // Direct match first (fast path)
  if (record[key]) return record[key];
  // Case-insensitive fallback
  const lower = key.toLowerCase();
  for (const k of Object.keys(record)) {
    if (k.toLowerCase() === lower) return record[k];
  }
  return undefined;
}

function matchPattern(
  pat: { type: string; key?: string; compiled: CompiledPattern },
  signals: CapturedSignals
): PatternMatch[] {
  const results: PatternMatch[] = [];

  switch (pat.type) {
    case "headers": {
      // manyToMany: headers is Record<string, string[]>
      // Keys are case-insensitive — look up lowercased pattern key against lowercased signal keys
      if (!signals.headers || !pat.key) break;
      const hValues = findCaseInsensitive(signals.headers, pat.key);
      if (!hValues) break;
      for (const val of hValues) {
        if (pat.compiled.regex.exec(val)) {
          results.push({ signal: `headers:${pat.key}`, matchedValue: val });
        }
      }
      break;
    }

    case "cookies": {
      // manyToMany: cookies is Record<string, string[]>
      // Keys are case-insensitive
      if (!signals.cookies || !pat.key) break;
      const cValues = findCaseInsensitive(signals.cookies, pat.key);
      if (!cValues) break;
      for (const val of cValues) {
        if (pat.compiled.regex.exec(val)) {
          results.push({ signal: `cookies:${pat.key}`, matchedValue: val });
        }
      }
      break;
    }

    case "js": {
      // js is Record<string, string> — key is property path, value is runtime result
      // Keys are case-sensitive (JS property names)
      if (!signals.js || !pat.key) break;
      const val = signals.js[pat.key];
      if (val === undefined) break;
      // For js signals, always pass the actual value as matchedValue
      // Empty pattern = "key exists" check, non-empty = regex against value
      const isEmpty = pat.compiled.regex.source === "" || pat.compiled.regex.source === "(?:)";
      if (isEmpty || pat.compiled.regex.exec(val)) {
        results.push({ signal: `js:${pat.key}`, matchedValue: val });
      }
      break;
    }

    case "meta": {
      // manyToMany: meta is Record<string, string[]>
      // Keys are case-insensitive
      if (!signals.meta || !pat.key) break;
      const mValues = findCaseInsensitive(signals.meta, pat.key);
      if (!mValues) break;
      for (const val of mValues) {
        if (pat.compiled.regex.exec(val)) {
          results.push({ signal: `meta:${pat.key}`, matchedValue: val });
        }
      }
      break;
    }

    case "scriptSrc": {
      // oneToMany: scriptSrc is string[]
      if (!signals.scriptSrc) break;
      for (const src of signals.scriptSrc) {
        if (pat.compiled.regex.exec(src)) {
          results.push({ signal: "scriptSrc", matchedValue: src });
        }
      }
      break;
    }

    case "html": {
      // oneToOne: html is string
      if (!signals.html) break;
      if (pat.compiled.regex.exec(signals.html)) {
        results.push({ signal: "html", matchedValue: signals.html });
      }
      break;
    }

    case "css": {
      // oneToOne: css is string
      if (!signals.css) break;
      if (pat.compiled.regex.exec(signals.css)) {
        results.push({ signal: "css", matchedValue: signals.css });
      }
      break;
    }

    case "url": {
      // oneToOne: url is string
      if (!signals.url) break;
      if (pat.compiled.regex.exec(signals.url)) {
        results.push({ signal: "url", matchedValue: signals.url });
      }
      break;
    }
  }

  return results;
}

/**
 * Build a full TechnographicResult from detections.
 */
export function buildTechnographicResult(
  detections: TechDetection[],
  signals: CapturedSignals,
  confidenceThreshold = 50
): TechnographicResult {
  const categories: Record<string, TechDetection[]> = {};

  for (const det of detections) {
    for (const cat of det.categories) {
      if (!categories[cat.name]) {
        categories[cat.name] = [];
      }
      categories[cat.name].push(det);
    }
  }

  const signalsUsed = new Set<string>();
  for (const det of detections) {
    for (const s of det.matchedSignals) {
      signalsUsed.add(s.split(":")[0]);
    }
  }

  return {
    technologies: detections.sort((a, b) => b.confidence - a.confidence),
    categories,
    totalDetected: detections.length,
    highConfidenceCount: detections.filter((d) => d.confidence >= confidenceThreshold).length,
    signalsUsed: Array.from(signalsUsed),
  };
}

/**
 * Get the number of technologies in the curated DB.
 */
export function getDatabaseSize(): number {
  return Object.keys(FINGERPRINT_DB).length;
}

/**
 * Reset compiled DB (for testing).
 */
export function resetCompiledDB(): void {
  compiledDB = null;
}
