import { describe, it, expect } from "vitest";
import { FRAMEWORK_SIGNALS } from "@/extension/sensors/framework-sensor";
import type { FrameworkDetection } from "@/extension/sensors/framework-sensor";
describe("FRAMEWORK_SIGNALS", () => {
  it("includes all expected frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("React");
    expect(names).toContain("Vue.js");
    expect(names).toContain("Angular");
    expect(names).toContain("Next.js");
    expect(names).toContain("Nuxt");
    expect(names).toContain("Svelte");
  });

  it("includes ah-17 expansion frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("Qwik");
    expect(names).toContain("SolidJS");
    expect(names).toContain("Lit");
    expect(names).toContain("Preact");
    expect(names).toContain("Alpine.js");
    expect(names).toContain("HTMX");
    expect(names).toContain("Turbo");
    expect(names).toContain("Stencil");
  });

  it("includes fw-hardening weak-signal frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("Vercel");
    expect(names).toContain("Netlify");
    expect(names).toContain("Hydrogen");
    expect(names).toContain("Carrd");
    expect(names).toContain("Gridsome");
  });

  it("includes fw-tier2 JS library and CSS frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("jQuery");
    expect(names).toContain("Bootstrap");
    expect(names).toContain("Tailwind CSS");
    expect(names).toContain("Backbone.js");
    expect(names).toContain("Ember.js");
    expect(names).toContain("Knockout");
    expect(names).toContain("Polymer");
    expect(names).toContain("Stimulus");
    expect(names).toContain("Marko");
    expect(names).toContain("Riot");
    expect(names).toContain("Mithril");
    expect(names).toContain("Inferno");
  });

  it("fw-hardening: header-only frameworks have empty globals and dom", () => {
    expect(FRAMEWORK_SIGNALS["Vercel"].globals).toEqual([]);
    expect(FRAMEWORK_SIGNALS["Vercel"].dom).toEqual([]);
    expect(FRAMEWORK_SIGNALS["Netlify"].globals).toEqual([]);
    expect(FRAMEWORK_SIGNALS["Netlify"].dom).toEqual([]);
  });

  it("fw-hardening: Hydrogen is meta-framework with Shopify parent", () => {
    expect(FRAMEWORK_SIGNALS["Hydrogen"].parent).toBe("Shopify");
  });

  it("fw-hardening: Gridsome is meta-framework with Vue parent", () => {
    expect(FRAMEWORK_SIGNALS["Gridsome"].parent).toBe("Vue");
  });

  it("includes fw-tier1 expansion frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("Shopify");
    expect(names).toContain("WooCommerce");
    expect(names).toContain("Squarespace");
    expect(names).toContain("Wix");
    expect(names).toContain("Framer");
    expect(names).toContain("Drupal");
    expect(names).toContain("Magento");
    expect(names).toContain("Joomla");
    expect(names).toContain("Ghost");
    expect(names).toContain("Bubble");
  });

  it("WooCommerce references WordPress as parent", () => {
    expect(FRAMEWORK_SIGNALS["WooCommerce"].parent).toBe("WordPress");
  });

  it("every signal has globals array, dom array, and parent field", () => {
    for (const [name, signal] of Object.entries(FRAMEWORK_SIGNALS)) {
      expect(Array.isArray(signal.globals), `${name}.globals should be array`).toBe(true);
      expect(Array.isArray(signal.dom), `${name}.dom should be array`).toBe(true);
      expect("parent" in signal, `${name} should have parent field`).toBe(true);
    }
  });

  it("includes fw-tier3 backend, hosting, and SSG frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("Laravel");
    expect(names).toContain("Django");
    expect(names).toContain("Ruby on Rails");
    expect(names).toContain("Cloudflare");
    expect(names).toContain("Hugo");
    expect(names).toContain("Jekyll");
    expect(names).toContain("Hexo");
    expect(names).toContain("Docusaurus");
    expect(names).toContain("VuePress");
    expect(names).toContain("Eleventy");
  });

  it("includes fw-tier4 builder and e-commerce frameworks", () => {
    const names = Object.keys(FRAMEWORK_SIGNALS);
    expect(names).toContain("GoDaddy");
    expect(names).toContain("Tilda");
    expect(names).toContain("Duda");
    expect(names).toContain("Weebly");
    expect(names).toContain("Carrd");
    expect(names).toContain("BigCommerce");
    expect(names).toContain("PrestaShop");
    expect(names).toContain("OpenCart");
    expect(names).toContain("Hydrogen");
  });

  it("Hydrogen references Shopify as parent", () => {
    expect(FRAMEWORK_SIGNALS["Hydrogen"].parent).toBe("Shopify");
  });

  it("VuePress references Vue as parent", () => {
    expect(FRAMEWORK_SIGNALS["VuePress"].parent).toBe("Vue");
  });

  it("meta-frameworks reference a parent", () => {
    expect(FRAMEWORK_SIGNALS["Next.js"].parent).toBe("React");
    expect(FRAMEWORK_SIGNALS["Nuxt"].parent).toBe("Vue");
    expect(FRAMEWORK_SIGNALS["SvelteKit"].parent).toBe("Svelte");
    expect(FRAMEWORK_SIGNALS["Remix"].parent).toBe("React");
    expect(FRAMEWORK_SIGNALS["Gatsby"].parent).toBe("React");
  });

  it("core frameworks have null parent", () => {
    expect(FRAMEWORK_SIGNALS["React"].parent).toBeNull();
    expect(FRAMEWORK_SIGNALS["Vue.js"].parent).toBeNull();
    expect(FRAMEWORK_SIGNALS["Angular"].parent).toBeNull();
  });
});

describe("FrameworkDetection type", () => {
  it("accepts valid detection object", () => {
    const detection: FrameworkDetection = {
      name: "React",
      version: "18.2.0",
      confidence: "high",
      method: "global __REACT_DEVTOOLS_GLOBAL_HOOK__",
    };
    expect(detection.name).toBe("React");
    expect(detection.confidence).toBe("high");
  });
});
