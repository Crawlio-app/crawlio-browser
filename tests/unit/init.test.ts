import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseFlags, buildStdioEntry, buildPortalEntry, buildCloudflareEntry, isAlreadyConfigured, isCloudflareConfigured, findMcpConfig, findConflictingConfigs, extractSkillName, createAppWrapper, CLIENT_REGISTRY, configureClient, configureAllClients } from "@/mcp-server/init";
import type { McpClientDef } from "@/mcp-server/init";
import { PKG_VERSION } from "@/shared/constants";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { platform, homedir } from "os";
import { resolve, join } from "path";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    platform: vi.fn(actual.platform),
  };
});

describe("parseFlags", () => {
  it("parses empty argv", () => {
    const opts = parseFlags([]);
    expect(opts).toEqual({
      portal: false,
      full: false,
      dryRun: false,
      plugin: false,
      cloudflare: false,
      agents: [],
      yes: false,
    });
  });

  it("parses --cloudflare flag", () => {
    const opts = parseFlags(["init", "--cloudflare"]);
    expect(opts.cloudflare).toBe(true);
  });

  it("parses --portal flag", () => {
    const opts = parseFlags(["init", "--portal"]);
    expect(opts.portal).toBe(true);
  });

  it("parses --dry-run flag", () => {
    const opts = parseFlags(["init", "--dry-run"]);
    expect(opts.dryRun).toBe(true);
  });

  it("parses --full flag", () => {
    const opts = parseFlags(["init", "--full"]);
    expect(opts.full).toBe(true);
  });

  it("parses --plugin flag", () => {
    const opts = parseFlags(["--plugin"]);
    expect(opts.plugin).toBe(true);
  });

  it("parses --yes flag", () => {
    const opts = parseFlags(["--yes"]);
    expect(opts.yes).toBe(true);
  });

  it("parses -y shorthand", () => {
    const opts = parseFlags(["-y"]);
    expect(opts.yes).toBe(true);
  });

  it("parses single -a agent", () => {
    const opts = parseFlags(["-a", "claude"]);
    expect(opts.agents).toEqual(["claude"]);
  });

  it("parses multiple -a agents", () => {
    const opts = parseFlags(["-a", "claude", "-a", "cursor"]);
    expect(opts.agents).toEqual(["claude", "cursor"]);
  });

  it("ignores -a without value", () => {
    const opts = parseFlags(["-a"]);
    expect(opts.agents).toEqual([]);
  });

  it("parses all flags together", () => {
    const opts = parseFlags(["init", "--portal", "--full", "--dry-run", "--plugin", "--cloudflare", "-y", "-a", "claude"]);
    expect(opts).toEqual({
      portal: true,
      full: true,
      dryRun: true,
      plugin: true,
      cloudflare: true,
      agents: ["claude"],
      yes: true,
    });
  });

  it("ignores unknown flags", () => {
    const opts = parseFlags(["init", "--unknown", "--foo"]);
    expect(opts.portal).toBe(false);
    expect(opts.dryRun).toBe(false);
  });
});

describe("CLIENT_REGISTRY", () => {
  it("contains 14 client definitions", () => {
    expect(CLIENT_REGISTRY).toHaveLength(14);
  });

  it("every client has required fields", () => {
    for (const client of CLIENT_REGISTRY) {
      expect(client.name).toBeTruthy();
      expect(client.configPath).toBeTruthy();
      expect(client.serverKey).toBeTruthy();
      expect(["json", "toml", "yaml"]).toContain(client.format);
      expect(typeof client.detect).toBe("function");
    }
  });

  it("has exactly one TOML client (Codex)", () => {
    const toml = CLIENT_REGISTRY.filter(c => c.format === "toml");
    expect(toml).toHaveLength(1);
    expect(toml[0].name).toBe("Codex CLI");
  });

  it("has exactly one YAML client (Goose)", () => {
    const yaml = CLIENT_REGISTRY.filter(c => c.format === "yaml");
    expect(yaml).toHaveLength(1);
    expect(yaml[0].name).toBe("Goose");
  });

  it("VS Code uses 'servers' key, not 'mcpServers'", () => {
    const vscode = CLIENT_REGISTRY.find(c => c.name === "VS Code");
    expect(vscode?.serverKey).toBe("servers");
  });
});

describe("configureClient", () => {
  const mockExistsSync = vi.mocked(existsSync);
  const mockReadFileSync = vi.mocked(readFileSync);
  const mockWriteFileSync = vi.mocked(writeFileSync);
  const mockMkdirSync = vi.mocked(mkdirSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseClient: McpClientDef = {
    name: "Test Client",
    configPath: "/tmp/test/mcp.json",
    serverKey: "mcpServers",
    format: "json",
    detect: () => true,
  };

  const entry = { command: "npx", args: ["-y", "crawlio-browser"] };

  it("writes JSON config to new file", () => {
    mockExistsSync.mockReturnValue(false);
    const result = configureClient(baseClient, entry, false);
    expect(result).toBe("configured");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string).trim());
    expect(written.mcpServers["crawlio-browser"]).toEqual(entry);
  });

  it("uses correct serverKey for VS Code (servers)", () => {
    const vsClient = { ...baseClient, serverKey: "servers" };
    mockExistsSync.mockReturnValue(false);
    configureClient(vsClient, entry, false);
    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string).trim());
    expect(written.servers["crawlio-browser"]).toEqual(entry);
  });

  it("skips when crawlio-browser already exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"mcpServers": {"crawlio-browser": {}}}');
    const result = configureClient(baseClient, entry, false);
    expect(result).toBe("skipped");
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("merges into existing config without overwriting other entries", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"mcpServers": {"other-server": {"command": "x"}}}');
    configureClient(baseClient, entry, false);
    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string).trim());
    expect(written.mcpServers["other-server"]).toEqual({ command: "x" });
    expect(written.mcpServers["crawlio-browser"]).toEqual(entry);
  });

  it("creates parent directories when needed", () => {
    mockExistsSync.mockReturnValue(false);
    configureClient(baseClient, entry, false);
    expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it("applies Cline transform (adds disabled: false)", () => {
    const clineClient = { ...baseClient, transform: (e: Record<string, unknown>) => ({ ...e, disabled: false }) };
    mockExistsSync.mockReturnValue(false);
    configureClient(clineClient, entry, false);
    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string).trim());
    expect(written.mcpServers["crawlio-browser"].disabled).toBe(false);
  });

  it("returns configured without writing in dry-run mode", () => {
    mockExistsSync.mockReturnValue(false);
    const result = configureClient(baseClient, entry, true);
    expect(result).toBe("configured");
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("handles TOML format (Codex)", () => {
    const tomlClient: McpClientDef = { ...baseClient, format: "toml", serverKey: "mcp_servers", configPath: "/tmp/test/config.toml" };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("[some_section]\nkey = \"value\"\n");
    configureClient(tomlClient, entry, false);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain("[mcp_servers.crawlio-browser]");
    expect(written).toContain('command = "npx"');
  });

  it("skips TOML when crawlio-browser section already exists", () => {
    const tomlClient: McpClientDef = { ...baseClient, format: "toml", serverKey: "mcp_servers", configPath: "/tmp/test/config.toml" };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("[mcp_servers.crawlio-browser]\ncommand = \"npx\"\n");
    const result = configureClient(tomlClient, entry, false);
    expect(result).toBe("skipped");
  });

  it("handles YAML format (Goose)", () => {
    const yamlClient: McpClientDef = { ...baseClient, format: "yaml", serverKey: "extensions", configPath: "/tmp/test/config.yaml" };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("extensions:\n  other-tool:\n    cmd: foo\n");
    configureClient(yamlClient, entry, false);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain("crawlio-browser:");
    expect(written).toContain("cmd: npx");
  });
});

describe("configureAllClients", () => {
  const mockExistsSync = vi.mocked(existsSync);
  const mockReadFileSync = vi.mocked(readFileSync);
  const mockPlatform = vi.mocked(platform);

  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue("linux");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("configures only detected clients", () => {
    // Make only Cursor detectable
    mockExistsSync.mockImplementation((p) => {
      return typeof p === "string" && p.includes(".cursor");
    });
    mockReadFileSync.mockReturnValue("{}");
    configureAllClients({ portal: false, full: false, dryRun: false, plugin: false, cloudflare: false, agents: [], yes: false });
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logCalls).toContain("Cursor");
  });

  it("filters by -a agent name", () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");
    configureAllClients({ portal: false, full: false, dryRun: false, plugin: false, cloudflare: false, agents: ["claude"], yes: false });
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    // Should attempt Claude Code and Claude Desktop (matched by name), not others
    expect(logCalls).toContain("Claude");
    expect(logCalls).not.toContain("Cursor");
  });

  it("prints manual instructions when no clients detected", () => {
    mockExistsSync.mockReturnValue(false);
    configureAllClients({ portal: false, full: false, dryRun: false, plugin: false, cloudflare: false, agents: [], yes: false });
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logCalls).toContain("No MCP clients detected");
  });

  it("reports already-configured clients as skipped", () => {
    mockExistsSync.mockImplementation((p) => {
      return typeof p === "string" && p.includes(".cursor");
    });
    mockReadFileSync.mockReturnValue('{"mcpServers": {"crawlio-browser": {}}}');
    configureAllClients({ portal: false, full: false, dryRun: false, plugin: false, cloudflare: false, agents: [], yes: false });
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logCalls).toContain("already configured");
  });
});

describe("buildStdioEntry", () => {
  const mockPlatform = vi.mocked(platform);

  beforeEach(() => {
    // Force non-macOS so .app wrapper is skipped — tests get deterministic npx output
    mockPlatform.mockReturnValue("linux");
  });

  afterEach(() => {
    mockPlatform.mockRestore();
  });

  it("returns code-mode config without version pin", () => {
    expect(buildStdioEntry()).toEqual({ command: "npx", args: ["-y", "crawlio-browser"] });
  });

  it("adds --full flag when full option is set", () => {
    expect(buildStdioEntry({ full: true })).toEqual({ command: "npx", args: ["-y", "crawlio-browser", "--full"] });
  });
});

describe("createAppWrapper", () => {
  const mockPlatform = vi.mocked(platform);

  afterEach(() => {
    mockPlatform.mockRestore();
  });

  it("returns null on non-macOS platforms", () => {
    mockPlatform.mockReturnValue("linux");
    expect(createAppWrapper("/some/path/index.js")).toBeNull();
  });
});

describe("buildPortalEntry", () => {
  it("returns correct portal config", () => {
    expect(buildPortalEntry()).toEqual({ type: "http", url: "http://127.0.0.1:3001/mcp" });
  });
});

describe("buildCloudflareEntry", () => {
  it("returns correct shape with account ID and token", () => {
    const entry = buildCloudflareEntry("abc123", "cf_token_xyz");
    expect(entry).toEqual({
      command: "npx",
      args: ["-y", "@cloudflare/mcp-server-cloudflare", "run", "abc123"],
      env: { CLOUDFLARE_API_TOKEN: "cf_token_xyz" },
    });
  });

  it("uses account ID as CLI positional arg (not env var)", () => {
    const entry = buildCloudflareEntry("my-account-id", "token");
    expect(entry.args[3]).toBe("my-account-id");
    expect(entry.env).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("isCloudflareConfigured", () => {
  it("returns true when cloudflare key exists", () => {
    const config = { mcpServers: { cloudflare: {} } };
    expect(isCloudflareConfigured(config)).toBe(true);
  });

  it("returns true when legacy cloudflare-bindings exists", () => {
    const config = { mcpServers: { "cloudflare-bindings": {} } };
    expect(isCloudflareConfigured(config)).toBe(true);
  });

  it("returns true when legacy cloudflare-builds exists", () => {
    const config = { mcpServers: { "cloudflare-builds": {} } };
    expect(isCloudflareConfigured(config)).toBe(true);
  });

  it("returns false when no cloudflare entry exists", () => {
    const config = { mcpServers: { "crawlio-browser": {} } };
    expect(isCloudflareConfigured(config)).toBe(false);
  });

  it("returns false with empty mcpServers", () => {
    const config = { mcpServers: {} };
    expect(isCloudflareConfigured(config)).toBe(false);
  });
});

describe("isAlreadyConfigured", () => {
  it("returns true when crawlio-browser exists in mcpServers", () => {
    const config = { mcpServers: { "crawlio-browser": { command: "npx", args: ["-y", "crawlio-browser"] } } };
    expect(isAlreadyConfigured(config)).toBe(true);
  });

  it("returns true when crawlio-agent alias exists", () => {
    const config = { mcpServers: { "crawlio-agent": { command: "node", args: ["/path/to/index.js"] } } };
    expect(isAlreadyConfigured(config)).toBe(true);
  });

  it("returns true when args contain crawlio-browser under different key", () => {
    const config = { mcpServers: { "my-browser": { command: "npx", args: ["-y", "crawlio-browser@1.4.0"] } } };
    expect(isAlreadyConfigured(config)).toBe(true);
  });

  it("returns true when command path contains crawlio-browser", () => {
    const config = { mcpServers: { "browser": { command: "/path/to/crawlio-browser/dist/index.js", args: [] } } };
    expect(isAlreadyConfigured(config)).toBe(true);
  });

  it("returns false when crawlio-browser is missing", () => {
    const config = { mcpServers: { "other-server": {} } };
    expect(isAlreadyConfigured(config)).toBe(false);
  });

  it("returns false with empty mcpServers", () => {
    const config = { mcpServers: {} };
    expect(isAlreadyConfigured(config)).toBe(false);
  });
});

describe("findMcpConfig", () => {
  const mockExistsSync = vi.mocked(existsSync);
  const mockReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no .mcp.json exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(findMcpConfig()).toBeNull();
  });

  it("finds .mcp.json in cwd", () => {
    const cwdPath = `${process.cwd()}/.mcp.json`;
    mockExistsSync.mockImplementation((p) => p === cwdPath);
    mockReadFileSync.mockReturnValue('{"mcpServers": {"test": {}}}');

    const result = findMcpConfig();
    expect(result).not.toBeNull();
    expect(result!.path).toBe(cwdPath);
    expect(result!.config.mcpServers).toHaveProperty("test");
  });

  it("finds Claude Code global config at ~/.claude/mcp.json", () => {
    const claudePath = join(homedir(), ".claude", "mcp.json");
    mockExistsSync.mockImplementation((p) => p === claudePath);
    mockReadFileSync.mockReturnValue('{"mcpServers": {"some-server": {}}}');

    const result = findMcpConfig();
    expect(result).not.toBeNull();
    expect(result!.path).toBe(claudePath);
  });

  it("skips invalid JSON", () => {
    const cwdPath = `${process.cwd()}/.mcp.json`;
    mockExistsSync.mockImplementation((p) => p === cwdPath);
    mockReadFileSync.mockReturnValue("not json{{{");

    expect(findMcpConfig()).toBeNull();
  });

  it("skips JSON without mcpServers key", () => {
    const cwdPath = `${process.cwd()}/.mcp.json`;
    mockExistsSync.mockImplementation((p) => p === cwdPath);
    mockReadFileSync.mockReturnValue('{"something": "else"}');

    expect(findMcpConfig()).toBeNull();
  });
});

describe("findConflictingConfigs", () => {
  const mockExistsSync = vi.mocked(existsSync);
  const mockReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty when no configs exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(findConflictingConfigs()).toEqual([]);
  });

  it("detects crawlio-browser in cwd .mcp.json", () => {
    const cwdPath = `${process.cwd()}/.mcp.json`;
    mockExistsSync.mockImplementation((p) => p === cwdPath);
    mockReadFileSync.mockReturnValue('{"mcpServers": {"crawlio-browser": {}}}');
    expect(findConflictingConfigs()).toEqual([cwdPath]);
  });

  it("detects crawlio-agent alias as conflict", () => {
    const cwdPath = `${process.cwd()}/.mcp.json`;
    mockExistsSync.mockImplementation((p) => p === cwdPath);
    mockReadFileSync.mockReturnValue('{"mcpServers": {"crawlio-agent": {"command": "node"}}}');
    expect(findConflictingConfigs()).toEqual([cwdPath]);
  });
});

describe("extractSkillName", () => {
  it("extracts skill name from standard path", () => {
    expect(extractSkillName("skills/crawl-site/SKILL.md")).toBe("crawl-site");
  });

  it("extracts skill name with crawlio prefix", () => {
    expect(extractSkillName("skills/crawlio-mcp/SKILL.md")).toBe("crawlio-mcp");
  });

  it("returns null for agent paths", () => {
    expect(extractSkillName("agents/site-auditor.md")).toBeNull();
  });

  it("returns null for bare filename", () => {
    expect(extractSkillName("SKILL.md")).toBeNull();
  });

  it("returns null when skill name level is missing", () => {
    expect(extractSkillName("skills/SKILL.md")).toBeNull();
  });

  it("handles Windows-style backslashes", () => {
    expect(extractSkillName("skills\\audit-site\\SKILL.md")).toBe("audit-site");
  });

  it("handles deeper nesting", () => {
    expect(extractSkillName("skills/observe/sub/README.md")).toBe("observe");
  });
});

describe("version sync", () => {
  it("PKG_VERSION matches package.json version", async () => {
    // Use dynamic import to bypass the mocked fs module
    const { readFileSync: realRead } = await vi.importActual<typeof import("fs")>("fs");
    const pkg = JSON.parse(realRead(resolve(__dirname, "../../package.json"), "utf-8"));
    expect(PKG_VERSION).toBe(pkg.version);
  });

  it("server.json (MCP registry manifest) version + package identifier stay in sync", async () => {
    const { readFileSync: realRead } = await vi.importActual<typeof import("fs")>("fs");
    const server = JSON.parse(realRead(resolve(__dirname, "../../server.json"), "utf-8"));
    expect(server.version).toBe(PKG_VERSION);
    const npmPkg = (server.packages ?? []).find((p: { registryType?: string }) => p.registryType === "npm");
    expect(npmPkg?.version).toBe(PKG_VERSION);
    expect(npmPkg?.identifier).toBe("crawlio-browser");
  });
});
