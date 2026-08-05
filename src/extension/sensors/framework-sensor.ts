// Framework detection signal reference
// Used by both background.ts (via CDP Runtime.evaluate) and content.ts
// Chrome tracks ReactPageLoad, VuePageLoad, AngularPageLoad,
// PreactPageLoad + DOM markers (data-reactroot, __reactFiber, __vue__, __vue_app__)

export interface FrameworkDetection {
  name: string;
  version?: string;
  confidence: "high" | "medium" | "low";
  method: string;
}

export interface FrameworkResult {
  framework: string;
  subtype?: string;
  confidence: "high" | "medium" | "low";
  signals: string[];
  version?: string;
  ssrMode?: string;
  // New: multi-framework detection
  detections: FrameworkDetection[];
  primary?: FrameworkDetection;
  subFrameworks: FrameworkDetection[];
}

export const FRAMEWORK_SIGNALS = {
  // Meta-frameworks (check first — they imply parent framework)
  "Next.js":    { globals: ["__NEXT_DATA__", "__next_f"], dom: ["#__next", "next-route-announcer"], parent: "React" },
  "Nuxt":       { globals: ["__NUXT__", "__nuxt"], dom: ["#__nuxt"], parent: "Vue" },
  "SvelteKit":  { globals: ["__sveltekit"], dom: [], parent: "Svelte" },
  "Remix":      { globals: ["__remixContext"], dom: [], parent: "React" },
  "Gatsby":     { globals: ["___gatsby"], dom: ["#___gatsby"], parent: "React" },
  // Core frameworks
  "Vue.js":     { globals: ["__vue_app__", "__VUE__"], dom: ["[data-v-]"], parent: null },
  "React":      { globals: ["__REACT_DEVTOOLS_GLOBAL_HOOK__"], dom: ["[data-reactroot]", "[data-reactroot] ~ *"], parent: null },
  "Angular":    { globals: [], dom: ["[ng-version]"], parent: null },
  "Svelte":     { globals: ["__svelte_meta"], dom: ["[class*='svelte-']"], parent: null },
  "Astro":      { globals: [], dom: ["astro-island", 'meta[name="generator"][content^="Astro"]'], parent: null },
  // New frameworks (ah-17)
  "Qwik":       { globals: [], dom: ["html[q\\:container]"], parent: null },
  "SolidJS":    { globals: ["_$HY"], dom: [], parent: null },
  "Lit":        { globals: ["litElementVersions"], dom: [], parent: null },
  "Preact":     { globals: ["__PREACT_DEVTOOLS__"], dom: [], parent: null },
  "Alpine.js":  { globals: [], dom: ["[x-data]"], parent: null },
  "HTMX":       { globals: ["htmx"], dom: ["[hx-get]", "[hx-post]", "[hx-trigger]"], parent: null },
  "Turbo":      { globals: ["Turbo"], dom: ["turbo-frame", "turbo-stream"], parent: null },
  "Stencil":    { globals: [], dom: ["[s-id]"], parent: null },
  // CMS/Platforms
  "WordPress":  { globals: [], dom: ["link[href*='wp-content']", "script[src*='wp-includes']"], parent: null },
  "Webflow":    { globals: [], dom: ["[data-wf-site]"], parent: null },
  // fw-hardening: 6 weak-signal frameworks
  "Vercel":     { globals: [], dom: [], parent: null },
  "Netlify":    { globals: [], dom: [], parent: null },
  "Hydrogen":   { globals: [], dom: [], parent: "Shopify" },
  "Carrd":      { globals: [], dom: ['link[href*="carrd.co"]'], parent: null },
  "Gridsome":   { globals: [], dom: ['meta[name="generator"][content*="Gridsome"]'], parent: "Vue" },
  // E-commerce + Builders + CMS (fw-tier1)
  "Shopify":      { globals: ["Shopify", "ShopifyAPI"], dom: ["link[href*='shopify.com']"], parent: null },
  "WooCommerce":  { globals: ["woocommerce_params"], dom: [".woocommerce", "link[rel*='woocommerce']"], parent: "WordPress" },
  "Squarespace":  { globals: ["Squarespace"], dom: [], parent: null },
  "Wix":          { globals: ["wixBiSession"], dom: [], parent: null },
  "Framer":       { globals: ["__framer_importFromPackage"], dom: [], parent: null },
  "Drupal":       { globals: ["Drupal"], dom: [], parent: null },
  "Magento":      { globals: ["Mage", "VarienForm"], dom: ["script[type='text/x-magento-init']", "script[data-requiremodule*='Magento_']"], parent: null },
  "Joomla":       { globals: ["Joomla"], dom: [], parent: null },
  "Ghost":        { globals: [], dom: ['meta[name="generator"][content*="Ghost"]'], parent: null },
  "Bubble":       { globals: ["_bubble_page_load_data", "bubble_environment"], dom: [], parent: null },
  // JS Libraries + CSS (fw-tier2)
  "jQuery":       { globals: ["jQuery"], dom: [], parent: null },
  "Bootstrap":    { globals: ["bootstrap"], dom: [], parent: null },
  "Tailwind CSS": { globals: ["tailwind"], dom: ["link[rel='stylesheet'][href*='tailwind']"], parent: null },
  "Backbone.js":  { globals: ["Backbone"], dom: [], parent: null },
  "Ember.js":     { globals: ["Ember", "EmberENV"], dom: [], parent: null },
  "Knockout":     { globals: ["ko"], dom: [], parent: null },
  "Polymer":      { globals: ["Polymer"], dom: [], parent: null },
  "Stimulus":     { globals: [], dom: ["[data-controller]"], parent: null },
  "Marko":        { globals: ["markoComponent", "markoSections"], dom: ["[data-marko-key]", "html[data-framework='marko']"], parent: null },
  "Riot":         { globals: ["riot"], dom: [], parent: null },
  "Mithril":      { globals: [], dom: ['script[src*="mithril"]'], parent: null },
  "Inferno":      { globals: ["Inferno"], dom: [], parent: null },
  // Backend + Hosting + SSGs (fw-tier3)
  "Laravel":        { globals: ["Laravel"], dom: ['meta[name="csrf-token"]', 'input[name="_token"]'], parent: null },
  "Django":         { globals: ["__admin_media_prefix__", "django"], dom: ['input[name="csrfmiddlewaretoken"]'], parent: null },
  "Ruby on Rails":  { globals: ["_rails_loaded"], dom: ['meta[name="csrf-param"][content="authenticity_token"]'], parent: null },
  // Vercel — ALREADY IN framework-sensor.ts (fw-hardening, header-based)
  // Netlify — ALREADY IN framework-sensor.ts (fw-hardening, header-based)
  "Cloudflare":     { globals: ["CloudFlare"], dom: ['img[src*="cdn.cloudflare"]'], parent: null },
  "Hugo":           { globals: [], dom: ['meta[name="generator"][content*="Hugo"]'], parent: null },
  "Jekyll":         { globals: ["SimpleJekyllSearch"], dom: ['meta[name="generator"][content*="Jekyll"]'], parent: null },
  "Hexo":           { globals: [], dom: ['meta[name="generator"][content*="Hexo"]'], parent: null },
  "Docusaurus":     { globals: ["__DOCUSAURUS_INSERT_BASEURL_BANNER", "docusaurus"], dom: ['meta[name="generator"][content*="Docusaurus"]'], parent: null },
  "VuePress":       { globals: ["__VUEPRESS__"], dom: ['meta[name="generator"][content*="VuePress"]'], parent: "Vue" },
  // Gridsome — ALREADY IN framework-sensor.ts (fw-hardening, meta-generator)
  "Eleventy":       { globals: [], dom: ['meta[name="generator"][content*="Eleventy"]'], parent: null },
  // Long-tail Builders + E-commerce (fw-tier4)
  "GoDaddy":        { globals: [], dom: ['meta[name="generator"][content*="GoDaddy"]'], parent: null },
  "Tilda":          { globals: [], dom: ['script[src*="tildacdn"]'], parent: null },
  "Duda":           { globals: ["SystemID", "d_version"], dom: ['script[src*="multiscreensite.com"]'], parent: null },
  "Weebly":         { globals: [], dom: ['script[src*="editmysite.com"]'], parent: null },
  // Carrd — ALREADY IN framework-sensor.ts (fw-hardening)
  "BigCommerce":    { globals: ["bigcommerce_config", "bigcommerce_i18n"], dom: ['link[href*=".bigcommerce.com"]', 'img[src*=".bigcommerce.com"]'], parent: null },
  "PrestaShop":     { globals: ["prestashop"], dom: ['meta[name="generator"][content*="PrestaShop"]'], parent: null },
  "OpenCart":        { globals: [], dom: ['link[href*="opencart"]'], parent: null },
  // Hydrogen — ALREADY IN framework-sensor.ts (fw-hardening, header-based)
} as const;

// Meta-frameworks take priority as "primary" when detected alongside their parent
