import { describe, it, expect } from "vitest";
import { compileRecording, sanitizeSkillName } from "../../src/mcp-server/recording-compiler.js";
import type { RecordingSession, RecordingPage, RecordingInteraction } from "../../src/shared/types.js";

// --- Test Fixtures ---

function createTestInteraction(overrides?: Partial<RecordingInteraction>): RecordingInteraction {
  return {
    timestamp: "2026-03-03T10:00:00Z",
    tool: "browser_click",
    args: { selector: "#btn" },
    durationMs: 50,
    pageUrl: "https://example.com",
    ...overrides,
  };
}

function createTestPage(overrides?: Partial<RecordingPage>): RecordingPage {
  return {
    url: "https://example.com",
    title: "Example Page",
    enteredAt: "2026-03-03T10:00:00Z",
    console: [],
    network: [],
    interactions: [createTestInteraction()],
    ...overrides,
  };
}

function createTestSession(overrides?: Partial<RecordingSession>): RecordingSession {
  return {
    id: "test-session-1",
    startedAt: "2026-03-03T10:00:00Z",
    stoppedAt: "2026-03-03T10:01:00Z",
    duration: 60,
    pages: [createTestPage()],
    metadata: {
      tabId: 1,
      initialUrl: "https://example.com",
      stopReason: "manual",
    },
    ...overrides,
  };
}

// ============================================================
// sanitizeSkillName
// ============================================================

describe("sanitizeSkillName", () => {
  it("converts spaces to hyphens", () => {
    expect(sanitizeSkillName("my skill name")).toBe("my-skill-name");
  });

  it("converts underscores to hyphens", () => {
    expect(sanitizeSkillName("my_skill_name")).toBe("my-skill-name");
  });

  it("strips special characters", () => {
    expect(sanitizeSkillName("skill@#$%!name")).toBe("skillname");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeSkillName("skill---name")).toBe("skill-name");
  });

  it("trims edge hyphens", () => {
    expect(sanitizeSkillName("-skill-name-")).toBe("skill-name");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    const result = sanitizeSkillName(long);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("returns 'unnamed-skill' for empty input", () => {
    expect(sanitizeSkillName("")).toBe("unnamed-skill");
    expect(sanitizeSkillName("!!!")).toBe("unnamed-skill");
  });
});

// ============================================================
// Frontmatter
// ============================================================

describe("compileRecording frontmatter", () => {
  it("emits valid YAML frontmatter with name, description, allowed-tools", () => {
    const result = compileRecording(createTestSession(), { name: "Login Flow" });
    const lines = result.skillMarkdown.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("name: login-flow");
    expect(lines[2]).toMatch(/^description: /);
    expect(lines[3]).toBe("allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab");
    expect(lines[4]).toBe("---");
  });

  it("uses provided description in frontmatter", () => {
    const result = compileRecording(createTestSession(), { name: "Test", description: "Custom description" });
    expect(result.skillMarkdown).toContain("description: Custom description");
  });

  it("auto-generates description when omitted", () => {
    const result = compileRecording(createTestSession(), { name: "Test" });
    expect(result.skillMarkdown).toContain("1 pages, 1 interactions");
  });

  it("kebab-cases the name in frontmatter", () => {
    const result = compileRecording(createTestSession(), { name: "My Cool Skill" });
    expect(result.skillMarkdown).toContain("name: my-cool-skill");
  });
});

// ============================================================
// Smart wrapper mappings
// ============================================================

describe("smart wrapper mappings", () => {
  it("maps browser_navigate to smart.navigate()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_navigate", args: { url: "https://example.com/page" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.navigate("https://example.com/page")');
  });

  it("maps browser_click with selector to smart.click()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_click", args: { selector: "#submit-btn" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.click("#submit-btn")');
  });

  it("maps browser_click with ref to smart.click()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_click", args: { ref: "button[data-id]" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.click("button[data-id]")');
  });

  it("maps browser_type to smart.type()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_type", args: { selector: "#email", text: "user@example.com" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.type("#email", "user@example.com")');
  });

  it("maps browser_type with clearFirst to smart.type() with options", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_type", args: { selector: "#field", text: "new value", clearFirst: true } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.type("#field", "new value", { clearFirst: true })');
  });

  it("maps browser_evaluate to smart.evaluate()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_evaluate", args: { expression: "document.title" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.evaluate("document.title")');
  });
});

// ============================================================
// Bridge.send fallbacks
// ============================================================

describe("bridge.send fallbacks", () => {
  it("maps browser_press_key to bridge.send()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_press_key", args: { key: "Enter" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('bridge.send(');
    expect(result.skillMarkdown).toContain('"browser_press_key"');
    expect(result.skillMarkdown).toContain('"Enter"');
  });

  it("maps browser_hover with waitFor prepended", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_hover", args: { selector: ".menu-item" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.waitFor(".menu-item")');
    expect(result.skillMarkdown).toContain('"browser_hover"');
  });

  it("maps browser_select_option with waitFor prepended", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_select_option", args: { selector: "#dropdown", value: "opt1" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.waitFor("#dropdown")');
    expect(result.skillMarkdown).toContain('"browser_select_option"');
  });

  it("maps browser_scroll without waitFor (may be page-level)", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_scroll", args: { direction: "down", amount: 500 } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('"browser_scroll"');
    expect(result.skillMarkdown).not.toContain("smart.waitFor");
  });

  it("maps browser_double_click with waitFor prepended", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_double_click", args: { selector: ".item" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.waitFor(".item")');
    expect(result.skillMarkdown).toContain('"browser_double_click"');
  });

  it("maps browser_drag to bridge.send()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_drag", args: { startX: 10, startY: 20, endX: 100, endY: 200 } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('"browser_drag"');
    expect(result.skillMarkdown).not.toContain("smart.waitFor");
  });

  it("maps browser_fill_form to bridge.send()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_fill_form", args: { fields: [{ selector: "#name", value: "Alice" }] } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('"browser_fill_form"');
  });

  it("maps browser_file_upload with waitFor prepended", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_file_upload", args: { selector: "#file-input", filePath: "/tmp/doc.pdf" } })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.waitFor("#file-input")');
    expect(result.skillMarkdown).toContain('"browser_file_upload"');
  });
});

// ============================================================
// Page transitions
// ============================================================

describe("page transitions", () => {
  it("injects checkpoint between pages", () => {
    const session = createTestSession({
      pages: [
        createTestPage({ title: "Page 1" }),
        createTestPage({ title: "Page 2", url: "https://example.com/page2" }),
      ],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain("await sleep(1000)");
    expect(result.skillMarkdown).toContain("await smart.snapshot()");
  });

  it("does not inject checkpoint after last page", () => {
    const session = createTestSession({
      pages: [createTestPage({ title: "Only Page" })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).not.toContain("await sleep(1000)");
    expect(result.skillMarkdown).not.toContain("await smart.snapshot()");
  });

  it("emits one code block per page", () => {
    const session = createTestSession({
      pages: [
        createTestPage({ title: "Page 1", interactions: [
          createTestInteraction({ tool: "browser_click", args: { selector: "#a" } }),
          createTestInteraction({ tool: "browser_click", args: { selector: "#b" } }),
        ]}),
      ],
    });
    const result = compileRecording(session, { name: "test" });
    // The page's interactions should be in the same code block
    const codeBlocks = result.skillMarkdown.match(/```js\n[\s\S]*?```/g) ?? [];
    // 1 page code block (no checkpoint blocks since single page)
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0]).toContain('smart.click("#a")');
    expect(codeBlocks[0]).toContain('smart.click("#b")');
  });

  it("uses page title in header, falls back to URL", () => {
    const withTitle = createTestSession({
      pages: [createTestPage({ title: "Dashboard", url: "https://app.com/dash" })],
    });
    const resultTitle = compileRecording(withTitle, { name: "test" });
    expect(resultTitle.skillMarkdown).toContain("## Page 1: Dashboard");

    const withoutTitle = createTestSession({
      pages: [createTestPage({ title: undefined, url: "https://app.com/settings" })],
    });
    const resultUrl = compileRecording(withoutTitle, { name: "test" });
    expect(resultUrl.skillMarkdown).toContain("## Page 1: https://app.com/settings");
  });
});

// ============================================================
// Edge cases
// ============================================================

describe("edge cases", () => {
  it("handles empty session (no pages)", () => {
    const session = createTestSession({ pages: [] });
    const result = compileRecording(session, { name: "Empty" });
    expect(result.pageCount).toBe(0);
    expect(result.interactionCount).toBe(0);
    expect(result.skillMarkdown).toContain("## Prerequisites");
    expect(result.skillMarkdown).toContain("## Session Info");
  });

  it("handles single page with no interactions", () => {
    const session = createTestSession({
      pages: [createTestPage({ interactions: [] })],
    });
    const result = compileRecording(session, { name: "Passive" });
    expect(result.interactionCount).toBe(0);
    expect(result.skillMarkdown).toContain("## Page 1:");
    expect(result.skillMarkdown).toContain("```js\n```");
  });

  it("emits comment for unknown tool", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({ tool: "browser_unknown_tool", args: {} })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain("// Unknown tool: browser_unknown_tool");
  });

  it("escapes special characters in selectors and text", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({
          tool: "browser_type",
          args: { selector: 'input[name="email"]', text: 'value with "quotes"' },
        })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    // JSON.stringify handles escaping
    expect(result.skillMarkdown).toContain('input[name=\\"email\\"]');
    expect(result.skillMarkdown).toContain('value with \\"quotes\\"');
  });

  it("includes session info footer", () => {
    const session = createTestSession({
      startedAt: "2026-03-03T10:00:00Z",
      duration: 120,
      metadata: { tabId: 1, initialUrl: "https://example.com", stopReason: "manual" },
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain("## Session Info");
    expect(result.skillMarkdown).toContain("**Recorded**: 2026-03-03T10:00:00Z");
    expect(result.skillMarkdown).toContain("**Duration**: 120s");
    expect(result.skillMarkdown).toContain("**Stop reason**: manual");
  });
});

// ============================================================
// Arg filtering
// ============================================================

describe("arg filtering", () => {
  it("strips protocol fields (type, id, _internal) from emitted args", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({
          tool: "browser_press_key",
          args: { type: "browser_press_key", id: "123", _internal: true, key: "Tab" },
        })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    // The emitted bridge.send should add its own type but not include id or _internal from args
    const output = result.skillMarkdown;
    expect(output).toContain('"key":"Tab"');
    // Should not have duplicate type or id/_internal from original args
    expect(output).not.toContain('"id":"123"');
    expect(output).not.toContain('"_internal"');
  });
});

// ============================================================
// CompileResult metadata
// ============================================================

describe("CompileResult metadata", () => {
  it("returns correct pageCount and interactionCount", () => {
    const session = createTestSession({
      pages: [
        createTestPage({ interactions: [createTestInteraction(), createTestInteraction()] }),
        createTestPage({ interactions: [createTestInteraction()] }),
      ],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.pageCount).toBe(2);
    expect(result.interactionCount).toBe(3);
    expect(result.name).toBe("test");
  });
});

// ============================================================
// User interaction tools (manual browser events)
// ============================================================

describe("user interaction tools", () => {
  it("maps user_click to smart.click()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({
          tool: "user_click",
          args: { selector: "#submit-btn", text: "Submit", x: 100, y: 200 },
        })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.click("#submit-btn")');
  });

  it("maps user_type to smart.type()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({
          tool: "user_type",
          args: { selector: "#email", text: "alice@test.com" },
        })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.type("#email", "alice@test.com")');
  });

  it("maps user_keypress to bridge.send()", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({
          tool: "user_keypress",
          args: { key: "Enter" },
        })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('"browser_press_key"');
    expect(result.skillMarkdown).toContain('"Enter"');
  });

  it("handles mixed MCP and user interactions in same page", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [
          createTestInteraction({ tool: "browser_navigate", args: { url: "https://app.com" } }),
          createTestInteraction({ tool: "user_click", args: { selector: ".menu-item" } }),
          createTestInteraction({ tool: "user_type", args: { selector: "#search", text: "query" } }),
          createTestInteraction({ tool: "user_keypress", args: { key: "Enter" } }),
          createTestInteraction({ tool: "browser_click", args: { selector: "#result" } }),
        ],
      })],
    });
    const result = compileRecording(session, { name: "mixed-test" });
    expect(result.skillMarkdown).toContain('await smart.navigate("https://app.com")');
    expect(result.skillMarkdown).toContain('await smart.click(".menu-item")');
    expect(result.skillMarkdown).toContain('await smart.type("#search", "query")');
    expect(result.skillMarkdown).toContain('"browser_press_key"');
    expect(result.skillMarkdown).toContain('await smart.click("#result")');
    expect(result.interactionCount).toBe(5);
  });

  it("handles user_click with empty selector gracefully", () => {
    const session = createTestSession({
      pages: [createTestPage({
        interactions: [createTestInteraction({
          tool: "user_click",
          args: {},
        })],
      })],
    });
    const result = compileRecording(session, { name: "test" });
    expect(result.skillMarkdown).toContain('await smart.click("")');
  });
});

// ============================================================
// Integration
// ============================================================

describe("integration", () => {
  it("compiles a multi-page session with mixed tools", () => {
    const session = createTestSession({
      pages: [
        createTestPage({
          title: "Login",
          url: "https://app.com/login",
          interactions: [
            createTestInteraction({ tool: "browser_navigate", args: { url: "https://app.com/login" } }),
            createTestInteraction({ tool: "browser_type", args: { selector: "#email", text: "alice@test.com" } }),
            createTestInteraction({ tool: "browser_type", args: { selector: "#pass", text: "secret123", clearFirst: true } }),
            createTestInteraction({ tool: "browser_click", args: { selector: "#login-btn" } }),
          ],
        }),
        createTestPage({
          title: "Dashboard",
          url: "https://app.com/dashboard",
          interactions: [
            createTestInteraction({ tool: "browser_hover", args: { selector: ".nav-menu" } }),
            createTestInteraction({ tool: "browser_click", args: { selector: ".nav-settings" } }),
            createTestInteraction({ tool: "browser_scroll", args: { direction: "down", amount: 300 } }),
          ],
        }),
      ],
      metadata: {
        tabId: 42,
        initialUrl: "https://app.com/login",
        stopReason: "manual",
      },
    });

    const result = compileRecording(session, { name: "Login and Settings", description: "End-to-end login flow" });

    // Frontmatter
    expect(result.skillMarkdown).toContain("name: login-and-settings");
    expect(result.skillMarkdown).toContain("description: End-to-end login flow");

    // Page 1: smart wrappers
    expect(result.skillMarkdown).toContain("## Page 1: Login");
    expect(result.skillMarkdown).toContain('await smart.navigate("https://app.com/login")');
    expect(result.skillMarkdown).toContain('await smart.type("#email", "alice@test.com")');
    expect(result.skillMarkdown).toContain('await smart.type("#pass", "secret123", { clearFirst: true })');
    expect(result.skillMarkdown).toContain('await smart.click("#login-btn")');

    // Checkpoint between pages
    expect(result.skillMarkdown).toContain("await sleep(1000)");
    expect(result.skillMarkdown).toContain("await smart.snapshot()");

    // Page 2: bridge fallbacks
    expect(result.skillMarkdown).toContain("## Page 2: Dashboard");
    expect(result.skillMarkdown).toContain('await smart.waitFor(".nav-menu")');
    expect(result.skillMarkdown).toContain('"browser_hover"');
    expect(result.skillMarkdown).toContain('await smart.click(".nav-settings")');
    expect(result.skillMarkdown).toContain('"browser_scroll"');

    // Session info
    expect(result.skillMarkdown).toContain("## Session Info");
    expect(result.skillMarkdown).toContain("**Stop reason**: manual");

    // Metadata
    expect(result.pageCount).toBe(2);
    expect(result.interactionCount).toBe(7);
    expect(result.name).toBe("login-and-settings");
  });
});
