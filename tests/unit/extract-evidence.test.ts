import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeEvidence, readEvidence } from "../../src/evidence/store.js";
import { wrapEvidence } from "../../src/evidence/wrap.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEnvelope } from "../../src/evidence/schema.js";
import type {
  DesignTokens,
  ColorToken,
  TypographyToken,
  SpacingToken,
  BreakpointToken,
  AuthFlow,
} from "../../src/shared/evidence-types.js";

// ── Factory Functions ──────────────────────────────────────────

function makeColorToken(overrides?: Partial<ColorToken>): ColorToken {
  return {
    name: "primary",
    value: "#3b82f6",
    usage: "primary",
    ...overrides,
  };
}

function makeTypographyToken(
  overrides?: Partial<TypographyToken>
): TypographyToken {
  return {
    family: "Inter",
    weight: "400",
    size: "16px",
    usage: "body",
    ...overrides,
  };
}

function makeSpacingToken(overrides?: Partial<SpacingToken>): SpacingToken {
  return {
    name: "sm",
    value: "8px",
    ...overrides,
  };
}

function makeBreakpointToken(
  overrides?: Partial<BreakpointToken>
): BreakpointToken {
  return {
    name: "md",
    value: "768px",
    type: "min-width",
    ...overrides,
  };
}

function makeDesignTokens(overrides?: Partial<DesignTokens>): DesignTokens {
  return {
    colors: [makeColorToken()],
    typography: [makeTypographyToken()],
    spacing: [makeSpacingToken()],
    breakpoints: [makeBreakpointToken()],
    cssCustomProperties: 12,
    signals: ["computed styles", "stylesheet analysis"],
    ...overrides,
  };
}

function makeAuthFlow(overrides?: Partial<AuthFlow>): AuthFlow {
  return {
    loginUrl: "/login",
    authType: "cookie",
    tokenStorage: "cookie",
    csrfProtection: true,
    oauthProvider: null,
    signals: ["login form detected", "csrf-token meta tag"],
    ...overrides,
  };
}

// ── DesignTokens Type Validation ───────────────────────────────

describe("DesignTokens type validation", () => {
  it("should have required fields", () => {
    const tokens = makeDesignTokens();
    expect(tokens.colors).toHaveLength(1);
    expect(tokens.typography).toHaveLength(1);
    expect(tokens.spacing).toHaveLength(1);
    expect(tokens.breakpoints).toHaveLength(1);
    expect(tokens.cssCustomProperties).toBe(12);
    expect(tokens.signals).toHaveLength(2);
  });

  it("should handle empty token arrays", () => {
    const tokens = makeDesignTokens({
      colors: [],
      typography: [],
      spacing: [],
      breakpoints: [],
      cssCustomProperties: 0,
      signals: [],
    });
    expect(tokens.colors).toHaveLength(0);
    expect(tokens.typography).toHaveLength(0);
    expect(tokens.spacing).toHaveLength(0);
    expect(tokens.breakpoints).toHaveLength(0);
    expect(tokens.cssCustomProperties).toBe(0);
  });

  it("should support multiple color tokens", () => {
    const tokens = makeDesignTokens({
      colors: [
        makeColorToken({ name: "primary", value: "#3b82f6", usage: "primary" }),
        makeColorToken({
          name: "background",
          value: "#ffffff",
          usage: "background",
        }),
        makeColorToken({ name: "text", value: "#1f2937", usage: "text" }),
      ],
    });
    expect(tokens.colors).toHaveLength(3);
    expect(tokens.colors[0].name).toBe("primary");
    expect(tokens.colors[2].usage).toBe("text");
  });

  it("should support null usage in tokens", () => {
    const color = makeColorToken({ usage: null });
    expect(color.usage).toBeNull();

    const typography = makeTypographyToken({
      weight: null,
      size: null,
      usage: null,
    });
    expect(typography.weight).toBeNull();
    expect(typography.size).toBeNull();
    expect(typography.usage).toBeNull();
  });

  it("should support all breakpoint types", () => {
    const tokens = makeDesignTokens({
      breakpoints: [
        makeBreakpointToken({ name: "sm", value: "640px", type: "min-width" }),
        makeBreakpointToken({
          name: "max-lg",
          value: "1024px",
          type: "max-width",
        }),
        makeBreakpointToken({
          name: "print",
          value: "print",
          type: "other",
        }),
      ],
    });
    expect(tokens.breakpoints).toHaveLength(3);
    expect(tokens.breakpoints[0].type).toBe("min-width");
    expect(tokens.breakpoints[1].type).toBe("max-width");
    expect(tokens.breakpoints[2].type).toBe("other");
  });
});

// ── AuthFlow Type Validation ───────────────────────────────────

describe("AuthFlow type validation", () => {
  it("should have required fields", () => {
    const auth = makeAuthFlow();
    expect(auth.loginUrl).toBe("/login");
    expect(auth.authType).toBe("cookie");
    expect(auth.tokenStorage).toBe("cookie");
    expect(auth.csrfProtection).toBe(true);
    expect(auth.oauthProvider).toBeNull();
    expect(auth.signals).toHaveLength(2);
  });

  it("should handle no auth detected", () => {
    const auth = makeAuthFlow({
      loginUrl: null,
      authType: "none",
      tokenStorage: null,
      csrfProtection: false,
      oauthProvider: null,
      signals: [],
    });
    expect(auth.loginUrl).toBeNull();
    expect(auth.authType).toBe("none");
    expect(auth.tokenStorage).toBeNull();
    expect(auth.csrfProtection).toBe(false);
    expect(auth.signals).toHaveLength(0);
  });

  it("should support JWT auth type", () => {
    const auth = makeAuthFlow({
      authType: "JWT",
      tokenStorage: "localStorage",
      signals: ["Authorization: Bearer header", "jwt token in localStorage"],
    });
    expect(auth.authType).toBe("JWT");
    expect(auth.tokenStorage).toBe("localStorage");
  });

  it("should support OAuth2 with provider", () => {
    const auth = makeAuthFlow({
      authType: "OAuth2",
      oauthProvider: "Google",
      signals: [
        "accounts.google.com redirect",
        "OAuth2 authorization_code flow",
      ],
    });
    expect(auth.authType).toBe("OAuth2");
    expect(auth.oauthProvider).toBe("Google");
  });

  it("should support API key auth type", () => {
    const auth = makeAuthFlow({
      authType: "API key",
      tokenStorage: null,
      signals: ["X-API-Key header detected"],
    });
    expect(auth.authType).toBe("API key");
  });

  it("should support all token storage locations", () => {
    for (const storage of ["cookie", "localStorage", "sessionStorage"]) {
      const auth = makeAuthFlow({ tokenStorage: storage });
      expect(auth.tokenStorage).toBe(storage);
    }
  });
});

// ── Extract Loop Definition ────────────────────────────────────

// ── Investigator Agent Tools ───────────────────────────────────

// ── writeEvidence with DesignTokens ────────────────────────────

describe("writeEvidence with DesignTokens", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extract-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read a DesignTokens envelope", async () => {
    const tokens = makeDesignTokens();
    const envelope: EvidenceEnvelope<DesignTokens> = {
      evidenceId: "ev_design_test1",
      type: "design",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-extractor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "extraction from captured page evidence",
      },
      gaps: [],
      quality: "complete",
      payload: tokens,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_parent",
    };

    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_design_test1.json");

    const read = await readEvidence<DesignTokens>("ev_design_test1", tmpDir);
    expect(read.type).toBe("design");
    expect(read.payload.colors).toHaveLength(1);
    expect(read.payload.colors[0].value).toBe("#3b82f6");
    expect(read.payload.typography).toHaveLength(1);
    expect(read.payload.cssCustomProperties).toBe(12);
    expect(read.payload.signals).toHaveLength(2);
  });

  it("should derive partial quality when gaps exist", async () => {
    const tokens = makeDesignTokens({ spacing: [], breakpoints: [] });
    const envelope: EvidenceEnvelope<DesignTokens> = {
      evidenceId: "ev_design_test2",
      type: "design",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-extractor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "extraction from captured page evidence",
      },
      gaps: [
        {
          dimension: "spacing",
          reason: "No spacing patterns detected in stylesheets",
          impact: "data-absent",
          reducesConfidence: false,
        },
        {
          dimension: "breakpoints",
          reason: "No media queries found",
          impact: "data-absent",
          reducesConfidence: false,
        },
      ],
      quality: "partial",
      payload: tokens,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_parent",
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<DesignTokens>("ev_design_test2", tmpDir);
    expect(read.quality).toBe("partial");
    expect(read.gaps).toHaveLength(2);
  });

  it("should use wrapEvidence to create a design envelope", () => {
    const tokens = makeDesignTokens();
    const envelope = wrapEvidence({
      type: "design",
      url: "https://example.com",
      payload: tokens,
      provenance: { source: "inferred", tool: "crawlio-extractor" },
      confidence: {
        level: "medium",
        basis: "extraction from captured page evidence",
      },
      parentId: "ev_crawl_parent",
    });

    expect(envelope.type).toBe("design");
    expect(envelope.evidenceId).toMatch(/^ev_/);
    expect(envelope.payload.colors).toHaveLength(1);
    expect(envelope.parentId).toBe("ev_crawl_parent");
    expect(envelope.quality).toBe("complete");
  });
});

// ── writeEvidence with AuthFlow ────────────────────────────────

describe("writeEvidence with AuthFlow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extract-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read an AuthFlow envelope", async () => {
    const auth = makeAuthFlow();
    const envelope: EvidenceEnvelope<AuthFlow> = {
      evidenceId: "ev_auth_test1",
      type: "auth",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-extractor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "extraction from captured page evidence",
      },
      gaps: [],
      quality: "complete",
      payload: auth,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_parent",
    };

    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_auth_test1.json");

    const read = await readEvidence<AuthFlow>("ev_auth_test1", tmpDir);
    expect(read.type).toBe("auth");
    expect(read.payload.loginUrl).toBe("/login");
    expect(read.payload.authType).toBe("cookie");
    expect(read.payload.csrfProtection).toBe(true);
    expect(read.payload.signals).toHaveLength(2);
  });

  it("should handle auth with all null fields", async () => {
    const auth = makeAuthFlow({
      loginUrl: null,
      authType: null,
      tokenStorage: null,
      csrfProtection: false,
      oauthProvider: null,
      signals: [],
    });
    const envelope: EvidenceEnvelope<AuthFlow> = {
      evidenceId: "ev_auth_test2",
      type: "auth",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-extractor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "low",
        basis: "no auth signals detected",
      },
      gaps: [
        {
          dimension: "authentication",
          reason: "No auth patterns detected",
          impact: "data-absent",
          reducesConfidence: true,
        },
      ],
      quality: "degraded",
      payload: auth,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_parent",
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<AuthFlow>("ev_auth_test2", tmpDir);
    expect(read.payload.loginUrl).toBeNull();
    expect(read.payload.authType).toBeNull();
    expect(read.payload.tokenStorage).toBeNull();
    // 1 explicit gap + 4 auto-detected null gaps (loginUrl, authType, tokenStorage, oauthProvider)
    expect(read.gaps.length).toBeGreaterThanOrEqual(1);
    const explicitGap = read.gaps.find(g => g.dimension === "authentication");
    expect(explicitGap).toBeDefined();
    expect(explicitGap!.reducesConfidence).toBe(true);
  });

  it("should use wrapEvidence to create an auth envelope", () => {
    const auth = makeAuthFlow();
    const envelope = wrapEvidence({
      type: "auth",
      url: "https://example.com",
      payload: auth,
      provenance: { source: "inferred", tool: "crawlio-extractor" },
      confidence: {
        level: "medium",
        basis: "extraction from captured page evidence",
      },
      parentId: "ev_crawl_parent",
    });

    expect(envelope.type).toBe("auth");
    expect(envelope.evidenceId).toMatch(/^ev_/);
    expect(envelope.payload.loginUrl).toBe("/login");
    expect(envelope.parentId).toBe("ev_crawl_parent");
    // oauthProvider is null in makeAuthFlow() → detectNullGaps auto-adds a gap → partial
    expect(envelope.quality).toBe("partial");
  });
});

// ── Skill Entry Point ──────────────────────────────────────────

describe("extract skill entry point", () => {
  it("should exist with correct frontmatter", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/extract/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("name: extract");
    expect(content).toContain(
      "allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab"
    );
  });

  it("should use Evidence Mode with smart.finding() and smart.extractPage()", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/extract/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("smart.finding(");
    expect(content).toContain("smart.findings()");
    expect(content).toContain("smart.extractPage()");
  });

  it("should document extraction methods and dimension tags", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/extract/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("detectTables");
    expect(content).toContain("extractTable");
    expect(content).toContain("extractData");
    expect(content).toContain("data-structure");
    expect(content).toContain("data-quality");
  });
});
