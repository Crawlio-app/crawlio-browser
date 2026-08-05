import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeEvidence, readEvidence } from "../../src/evidence/store.js";
import { wrapEvidence } from "../../src/evidence/wrap.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEnvelope } from "../../src/evidence/schema.js";
import type {
  CloneBlueprint,
  CloneComponent,
  CloneAsset,
} from "../../src/shared/evidence-types.js";

// ── Factory Functions ──────────────────────────────────────────

function makeComponent(overrides?: Partial<CloneComponent>): CloneComponent {
  return {
    name: "Header",
    type: "navigation",
    children: ["Logo", "NavLinks", "SearchBar"],
    props: { sticky: true },
    ...overrides,
  };
}

function makeAsset(overrides?: Partial<CloneAsset>): CloneAsset {
  return {
    url: "https://example.com/logo.png",
    type: "image",
    size: 24576,
    ...overrides,
  };
}

function makeCloneBlueprint(
  overrides?: Partial<CloneBlueprint>
): CloneBlueprint {
  return {
    url: "https://example.com",
    designTokens: {
      colors: [
        { name: "primary", value: "#3b82f6", usage: "buttons, links" },
        { name: "background", value: "#ffffff", usage: "page background" },
        { name: "text", value: "#1f2937", usage: "body text" },
      ],
      typography: [
        { family: "Inter", weight: "400", size: "16px", usage: "body" },
        { family: "Inter", weight: "700", size: "32px", usage: "heading" },
      ],
      spacing: [
        { name: "sm", value: "8px" },
        { name: "md", value: "16px" },
        { name: "lg", value: "32px" },
      ],
      breakpoints: [
        { name: "sm", value: "640px" },
        { name: "md", value: "768px" },
        { name: "lg", value: "1024px" },
      ],
    },
    componentTree: {
      root: "App",
      components: [
        makeComponent(),
        makeComponent({
          name: "MainContent",
          type: "content",
          children: ["Hero", "FeatureGrid"],
          props: {},
        }),
        makeComponent({
          name: "Footer",
          type: "layout",
          children: ["FooterLinks", "Copyright"],
          props: { dark: true },
        }),
      ],
    },
    assets: [
      makeAsset(),
      makeAsset({ url: "https://example.com/font.woff2", type: "font", size: 45000 }),
      makeAsset({ url: "https://example.com/main.css", type: "stylesheet", size: 12000 }),
      makeAsset({ url: "https://example.com/app.js", type: "script", size: 150000 }),
    ],
    compiledSkillPath: null,
    ...overrides,
  };
}

// ── CloneBlueprint Type Validation ─────────────────────────────

describe("CloneBlueprint type validation", () => {
  it("should have required fields", () => {
    const blueprint = makeCloneBlueprint();
    expect(blueprint.url).toBe("https://example.com");
    expect(blueprint.designTokens.colors).toHaveLength(3);
    expect(blueprint.designTokens.typography).toHaveLength(2);
    expect(blueprint.designTokens.spacing).toHaveLength(3);
    expect(blueprint.designTokens.breakpoints).toHaveLength(3);
    expect(blueprint.componentTree.root).toBe("App");
    expect(blueprint.componentTree.components).toHaveLength(3);
    expect(blueprint.assets).toHaveLength(4);
    expect(blueprint.compiledSkillPath).toBeNull();
  });

  it("should support compiled skill path", () => {
    const blueprint = makeCloneBlueprint({
      compiledSkillPath: "skills/clone-example-com/SKILL.md",
    });
    expect(blueprint.compiledSkillPath).toBe("skills/clone-example-com/SKILL.md");
  });

  it("should handle site with no design tokens", () => {
    const blueprint = makeCloneBlueprint({
      designTokens: {
        colors: [],
        typography: [],
        spacing: [],
        breakpoints: [],
      },
    });
    expect(blueprint.designTokens.colors).toHaveLength(0);
    expect(blueprint.designTokens.typography).toHaveLength(0);
    expect(blueprint.designTokens.spacing).toHaveLength(0);
    expect(blueprint.designTokens.breakpoints).toHaveLength(0);
  });

  it("should handle site with minimal component tree", () => {
    const blueprint = makeCloneBlueprint({
      componentTree: {
        root: "body",
        components: [],
      },
    });
    expect(blueprint.componentTree.root).toBe("body");
    expect(blueprint.componentTree.components).toHaveLength(0);
  });

  it("should handle site with no assets", () => {
    const blueprint = makeCloneBlueprint({ assets: [] });
    expect(blueprint.assets).toHaveLength(0);
  });
});

// ── Component Types ────────────────────────────────────────────

describe("CloneComponent type classification", () => {
  it("should support all 5 component types", () => {
    const types = ["layout", "navigation", "content", "interactive", "decorative"] as const;
    for (const type of types) {
      const component = makeComponent({ type });
      expect(component.type).toBe(type);
    }
  });

  it("should track children by name", () => {
    const component = makeComponent({
      name: "Sidebar",
      children: ["NavMenu", "UserProfile", "QuickLinks"],
    });
    expect(component.children).toHaveLength(3);
    expect(component.children).toContain("NavMenu");
  });

  it("should hold arbitrary props", () => {
    const component = makeComponent({
      props: { variant: "primary", size: "lg", onClick: "handleClick" },
    });
    expect(component.props.variant).toBe("primary");
    expect(component.props.size).toBe("lg");
  });
});

// ── Asset Types ────────────────────────────────────────────────

describe("CloneAsset type classification", () => {
  it("should support all 5 asset types", () => {
    const types = ["image", "font", "script", "stylesheet", "video"] as const;
    for (const type of types) {
      const asset = makeAsset({ type });
      expect(asset.type).toBe(type);
    }
  });

  it("should handle unknown size", () => {
    const asset = makeAsset({ size: null });
    expect(asset.size).toBeNull();
  });
});

// ── Clone Loop Definition ──────────────────────────────────────

// ── writeEvidence with CloneBlueprint ──────────────────────────

describe("writeEvidence with CloneBlueprint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clone-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read a CloneBlueprint envelope", async () => {
    const blueprint = makeCloneBlueprint();
    const envelope: EvidenceEnvelope<CloneBlueprint> = {
      evidenceId: "ev_clone_test1",
      type: "clone",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-synthesizer",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "high",
        basis: "Full page capture with design token extraction",
      },
      gaps: [],
      quality: "complete",
      payload: blueprint,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_1",
    };

    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_clone_test1.json");

    const read = await readEvidence<CloneBlueprint>("ev_clone_test1", tmpDir);
    expect(read.type).toBe("clone");
    expect(read.payload.url).toBe("https://example.com");
    expect(read.payload.designTokens.colors).toHaveLength(3);
    expect(read.payload.componentTree.root).toBe("App");
    expect(read.payload.assets).toHaveLength(4);
    expect(read.payload.compiledSkillPath).toBeNull();
  });

  it("should derive partial quality when gaps exist", async () => {
    const blueprint = makeCloneBlueprint({
      designTokens: {
        colors: [],
        typography: [],
        spacing: [],
        breakpoints: [],
      },
    });
    const envelope: EvidenceEnvelope<CloneBlueprint> = {
      evidenceId: "ev_clone_test2",
      type: "clone",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-synthesizer",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "Page capture succeeded but design token extraction failed",
      },
      gaps: [
        {
          dimension: "design-tokens",
          reason: "CSS-in-JS prevented static analysis of design tokens",
          impact: "data-absent",
          reducesConfidence: true,
        },
      ],
      quality: "partial",
      payload: blueprint,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<CloneBlueprint>("ev_clone_test2", tmpDir);
    expect(read.quality).toBe("partial");
    expect(read.gaps.length).toBeGreaterThanOrEqual(1);
  });

  it("should use wrapEvidence to create a clone envelope", () => {
    const blueprint = makeCloneBlueprint();
    const envelope = wrapEvidence({
      type: "clone",
      url: "https://example.com",
      payload: blueprint,
      provenance: { source: "inferred", tool: "crawlio-synthesizer" },
      confidence: {
        level: "high",
        basis: "Full page capture with design token extraction",
      },
      parentId: "ev_crawl_1",
    });

    expect(envelope.type).toBe("clone");
    expect(envelope.evidenceId).toMatch(/^ev_/);
    expect(envelope.payload.url).toBe("https://example.com");
    expect(envelope.payload.designTokens.colors).toHaveLength(3);
    expect(envelope.parentId).toBe("ev_crawl_1");
    // compiledSkillPath: null triggers detectNullGaps → quality is "partial"
    expect(envelope.quality).toBe("partial");
  });

  it("should handle blueprint with compiled skill path", async () => {
    const blueprint = makeCloneBlueprint({
      compiledSkillPath: "skills/clone-example-com/SKILL.md",
    });
    const envelope: EvidenceEnvelope<CloneBlueprint> = {
      evidenceId: "ev_clone_compiled",
      type: "clone",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-synthesizer",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "high",
        basis: "Full clone with compiled skill",
      },
      gaps: [],
      quality: "complete",
      payload: blueprint,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<CloneBlueprint>("ev_clone_compiled", tmpDir);
    expect(read.payload.compiledSkillPath).toBe("skills/clone-example-com/SKILL.md");
  });
});

// ── Skill Entry Point ──────────────────────────────────────────

describe("clone skill entry point", () => {
  it("should exist with correct frontmatter", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/clone/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("name: clone");
    expect(content).toContain(
      "allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab"
    );
  });

  it("should use Evidence Mode with smart.finding() and smart.extractPage()", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/clone/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("smart.finding(");
    expect(content).toContain("smart.findings()");
    expect(content).toContain("smart.extractPage()");
  });

  it("should describe design tokens, component patterns, and dimension tags", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/clone/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("design token");
    expect(content).toContain("component");
    expect(content).toContain("design-system");
    expect(content).toContain("typography");
    expect(content).toContain("layout");
    expect(content).toContain("technology");
  });
});
