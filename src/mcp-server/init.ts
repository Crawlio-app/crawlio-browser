import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, chmodSync, renameSync } from "fs";
import { join, resolve, dirname, sep, basename } from "path";
import { homedir, platform } from "os";
import { createServer as createNetServer } from "net";
import { createInterface } from "readline";
import { fileURLToPath } from "node:url";

const PORTAL_URL = "http://127.0.0.1:3001";
const HEALTH_URL = `${PORTAL_URL}/health`;
const MCP_URL = `${PORTAL_URL}/mcp`;
const HOME = homedir();

import { PKG_VERSION as VERSION } from "../shared/constants.js";
import { pingInstall, telemetryEnabled, getInstallId } from "./telemetry.js";

// ANSI colors
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const RESET = "\x1b[0m";

// Crawlio logo gradient — 6 shades of cyan-to-blue
const LOGO_GRADIENT = [
  "\x1b[38;5;87m",   // bright cyan
  "\x1b[38;5;80m",   // cyan
  "\x1b[38;5;74m",   // steel cyan
  "\x1b[38;5;68m",   // steel blue
  "\x1b[38;5;62m",   // medium blue
  "\x1b[38;5;56m",   // deep blue
];

// --- Helpers: safe file writing & escaping ---

function atomicWriteSync(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

export function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function escapeYaml(value: string): string {
  if (/[:#[\]{*&]/.test(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return value;
}

function escapeShellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- Types ---

export interface InitOptions {
  portal: boolean;
  full: boolean;
  dryRun: boolean;
  plugin: boolean;
  cloudflare: boolean;
  agents: string[];
  yes: boolean;
}

interface McpConfig {
  mcpServers: Record<string, unknown>;
}

interface McpConfigResult {
  path: string;
  config: McpConfig;
}

// --- Pure functions (exported for testing) ---

export function parseFlags(argv: string[]): InitOptions {
  const opts: InitOptions = {
    portal: false,
    full: false,
    dryRun: false,
    plugin: false,
    cloudflare: false,
    agents: [],
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--portal") opts.portal = true;
    else if (arg === "--full") opts.full = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--plugin") opts.plugin = true;
    else if (arg === "--cloudflare") opts.cloudflare = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "-a" && i + 1 < argv.length) {
      opts.agents.push(argv[++i]);
    }
  }

  return opts;
}

// --- Client registry for direct config writing ---

export interface McpClientDef {
  name: string;
  configPath: string;
  serverKey: string;
  format: "json" | "toml" | "yaml";
  detect: () => boolean;
  transform?: (entry: Record<string, unknown>) => unknown;
}

export const CLIENT_REGISTRY: McpClientDef[] = [
  {
    name: "Claude Code",
    configPath: join(HOME, ".claude.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".claude")),
  },
  {
    name: "Claude Desktop",
    configPath: join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, "Library", "Application Support", "Claude")),
  },
  {
    name: "VS Code",
    configPath: join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"),
    serverKey: "servers",
    format: "json",
    detect: () => existsSync(join(HOME, ".vscode")),
  },
  {
    name: "Cursor",
    configPath: join(HOME, ".cursor", "mcp.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".cursor")),
  },
  {
    name: "Windsurf",
    configPath: join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".codeium", "windsurf")),
  },
  {
    name: "Cline (VS Code)",
    configPath: join(HOME, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings")),
    transform: (entry) => ({ ...entry, disabled: false }),
  },
  {
    name: "Cline CLI",
    configPath: join(HOME, ".cline", "data", "settings", "cline_mcp_settings.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".cline")),
    transform: (entry) => ({ ...entry, disabled: false }),
  },
  {
    name: "Copilot CLI",
    configPath: join(HOME, ".copilot", "mcp-config.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".copilot")),
  },
  {
    name: "Gemini CLI",
    configPath: join(HOME, ".gemini", "settings.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".gemini")),
  },
  {
    name: "Codex CLI",
    configPath: join(HOME, ".codex", "config.toml"),
    serverKey: "mcp_servers",
    format: "toml",
    detect: () => existsSync(join(HOME, ".codex")),
  },
  {
    name: "Goose",
    configPath: join(HOME, ".config", "goose", "config.yaml"),
    serverKey: "extensions",
    format: "yaml",
    detect: () => existsSync(join(HOME, ".config", "goose")),
  },
  {
    name: "OpenCode",
    configPath: join(HOME, ".config", "opencode", "opencode.json"),
    serverKey: "mcp",
    format: "json",
    detect: () => existsSync(join(HOME, ".config", "opencode")),
    transform: (entry) => {
      const e = entry as { command: string; args?: string[] };
      return { command: [e.command, ...(e.args || [])], env: (entry as Record<string, unknown>).env };
    },
  },
  {
    name: "Zed",
    configPath: join(HOME, "Library", "Application Support", "Zed", "settings.json"),
    serverKey: "context_servers",
    format: "json",
    detect: () => existsSync(join(HOME, "Library", "Application Support", "Zed")),
    transform: (entry) => ({
      settings: { source: "custom", command: entry },
    }),
  },
  {
    name: "Antigravity",
    configPath: join(HOME, ".gemini", "antigravity", "mcp_config.json"),
    serverKey: "mcpServers",
    format: "json",
    detect: () => existsSync(join(HOME, ".gemini", "antigravity")),
  },
];

// --- Direct config writing ---

export function configureClient(
  client: McpClientDef,
  entry: Record<string, unknown>,
  dryRun: boolean,
): "configured" | "skipped" | "error" {
  const finalEntry = client.transform ? client.transform(entry) : entry;

  if (client.format === "json") {
    let config: Record<string, unknown> = {};
    if (existsSync(client.configPath)) {
      try {
        config = JSON.parse(readFileSync(client.configPath, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        console.log(`    ${yellow("!")} Corrupt JSON in ${client.configPath}: ${err instanceof Error ? err.message : String(err)}`);
        return "error";
      }
    }
    const section = (config[client.serverKey] || {}) as Record<string, unknown>;
    if ("crawlio-browser" in section) return "skipped";

    if (dryRun) return "configured";

    section["crawlio-browser"] = finalEntry;
    config[client.serverKey] = section;
    try {
      mkdirSync(dirname(client.configPath), { recursive: true });
      atomicWriteSync(client.configPath, JSON.stringify(config, null, 2) + "\n");
    } catch (err) {
      console.log(`    ${yellow("!")} Failed to write ${client.configPath}: ${err instanceof Error ? err.message : String(err)}`);
      return "error";
    }
    return "configured";
  }

  if (client.format === "toml") {
    let content = "";
    if (existsSync(client.configPath)) {
      content = readFileSync(client.configPath, "utf-8");
    }
    if (content.includes("[mcp_servers.crawlio-browser]") || content.includes('[mcp_servers."crawlio-browser"]')) {
      return "skipped";
    }

    if (dryRun) return "configured";

    const e = entry as { command: string; args?: string[] };
    const argsStr = (e.args || []).map((a: string) => `"${escapeToml(a)}"`).join(", ");
    const block = `\n[mcp_servers.crawlio-browser]\ncommand = "${escapeToml(e.command)}"\nargs = [${argsStr}]\n`;
    try {
      mkdirSync(dirname(client.configPath), { recursive: true });
      atomicWriteSync(client.configPath, content + block);
    } catch (err) {
      console.log(`    ${yellow("!")} Failed to write ${client.configPath}: ${err instanceof Error ? err.message : String(err)}`);
      return "error";
    }
    return "configured";
  }

  if (client.format === "yaml") {
    let content = "";
    if (existsSync(client.configPath)) {
      content = readFileSync(client.configPath, "utf-8");
    }
    if (content.includes("crawlio-browser:")) {
      return "skipped";
    }

    if (dryRun) return "configured";

    const e = entry as { command: string; args?: string[] };
    const argsYaml = (e.args || []).map((a: string) => `      - ${escapeYaml(a)}`).join("\n");
    const block = `\n  crawlio-browser:\n    name: crawlio-browser\n    type: stdio\n    cmd: ${escapeYaml(e.command)}\n    args:\n${argsYaml}\n`;
    // Ensure extensions: section exists
    if (!content.includes("extensions:")) {
      content += "\nextensions:\n";
    }
    try {
      mkdirSync(dirname(client.configPath), { recursive: true });
      atomicWriteSync(client.configPath, content + block);
    } catch (err) {
      console.log(`    ${yellow("!")} Failed to write ${client.configPath}: ${err instanceof Error ? err.message : String(err)}`);
      return "error";
    }
    return "configured";
  }

  return "error";
}

export function configureAllClients(options: InitOptions): void {
  const entry = options.portal
    ? (buildPortalEntry() as unknown as Record<string, unknown>)
    : (buildStdioEntry({ full: options.full, dryRun: options.dryRun }) as unknown as Record<string, unknown>);

  // Filter by -a flag or auto-detect
  const candidates = options.agents.length > 0
    ? CLIENT_REGISTRY.filter(c => options.agents.some(a => c.name.toLowerCase().includes(a.toLowerCase())))
    : CLIENT_REGISTRY.filter(c => c.detect());

  if (candidates.length === 0) {
    console.log(`    ${dim("  No MCP clients detected on this machine")}`);
    printManualInstructions(entry);
    return;
  }

  let configured = 0;
  let skipped = 0;
  for (const client of candidates) {
    const result = configureClient(client, entry, options.dryRun);
    if (result === "configured") {
      const prefix = options.dryRun ? dim("~") : green("+");
      console.log(`    ${prefix} ${client.name} ${dim("→ " + client.configPath)}`);
      configured++;
    } else if (result === "skipped") {
      console.log(`    ${dim("=")} ${client.name} ${dim("(already configured)")}`);
      skipped++;
    } else {
      console.log(`    ${yellow("!")} ${client.name} ${dim("— failed to write config")}`);
    }
  }

  if (configured === 0 && skipped > 0) {
    console.log(`    ${dim("  All detected clients already configured")}`);
  }
}

function printManualInstructions(entry: Record<string, unknown>): void {
  console.log("");
  console.log(`    ${dim("Add this to your MCP client config:")}`);
  console.log("");
  const snippet = { "crawlio-browser": entry };
  const lines = JSON.stringify(snippet, null, 2).split("\n");
  for (const line of lines) {
    console.log(`    ${dim(line)}`);
  }
  console.log("");
}

export function buildStdioEntry(options?: { full?: boolean; dryRun?: boolean }): { command: string; args: string[] } {
  // On macOS, try to create an .app wrapper for Activity Monitor branding
  if (platform() === "darwin" && !options?.dryRun) {
    const serverPath = getServerEntryPath();
    const wrapperPath = createAppWrapper(serverPath);
    if (wrapperPath) {
      const args: string[] = [];
      if (options?.full) args.push("--full");
      return { command: wrapperPath, args };
    }
  }

  // Fallback: use node directly with the resolved server path.
  // Avoids npx, which fails when cwd has a package.json with the same name.
  const serverPath = getServerEntryPath();
  if (existsSync(serverPath)) {
    const nodePath = resolveNodePath();
    const args = [serverPath];
    if (options?.full) args.push("--full");
    return { command: nodePath, args };
  }

  // Last resort: npx (works everywhere except inside the source repo)
  const args = ["-y", "crawlio-browser"];
  if (options?.full) args.push("--full");
  return { command: "npx", args };
}

export function buildPortalEntry(): { type: string; url: string } {
  return { type: "http", url: MCP_URL };
}

export function isAlreadyConfigured(config: McpConfig): boolean {
  // Direct key match
  if ("crawlio-browser" in config.mcpServers || "crawlio-agent" in config.mcpServers) return true;
  // Check if any entry runs crawlio-browser (alias detection)
  for (const entry of Object.values(config.mcpServers)) {
    const e = entry as Record<string, unknown>;
    const args = e?.args as string[] | undefined;
    if (args?.some(a => typeof a === "string" && a.includes("crawlio-browser"))) return true;
    const cmd = e?.command as string | undefined;
    if (cmd?.includes("crawlio-browser")) return true;
  }
  return false;
}

export function buildCloudflareEntry(accountId: string, apiToken: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: "npx",
    args: ["-y", "@cloudflare/mcp-server-cloudflare", "run", accountId],
    env: { CLOUDFLARE_API_TOKEN: apiToken },
  };
}

export function isCloudflareConfigured(config: McpConfig): boolean {
  return "cloudflare" in config.mcpServers ||
    "cloudflare-bindings" in config.mcpServers ||
    "cloudflare-builds" in config.mcpServers;
}

// --- Interactive prompt ---

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${dim(hint)} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" ? defaultYes : a === "y" || a === "yes");
    });
  });
}

// --- Environment detection ---

export function findMcpConfig(): McpConfigResult | null {
  const candidates = [
    join(process.cwd(), ".mcp.json"),
    join(HOME, ".mcp.json"),
    join(HOME, ".claude", "mcp.json"),   // Claude Code global config
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
        return { path: p, config: parsed as unknown as McpConfig };
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  return null;
}

/**
 * Check ALL known config locations for existing crawlio-browser entries.
 * Returns paths where a conflicting entry was found.
 * Used to inform about multi-instance configurations.
 */
export function findConflictingConfigs(): string[] {
  const locations = [
    join(process.cwd(), ".mcp.json"),
    join(HOME, ".mcp.json"),
    join(HOME, ".claude", "mcp.json"),
    // Claude Code project config (if different from cwd)
    join(process.cwd(), ".claude", "mcp.json"),
  ];

  const conflicts: string[] = [];
  for (const p of locations) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as McpConfig;
      if (parsed?.mcpServers && isAlreadyConfigured(parsed)) {
        conflicts.push(p);
      }
    } catch { /* skip */ }
  }
  return conflicts;
}

// --- Portal helpers (from setup.ts) ---

async function healthCheck(): Promise<{ ok: boolean; toolCount?: number; bridgeConnected?: boolean }> {
  try {
    const res = await fetch(HEALTH_URL);
    if (!res.ok) return { ok: false };
    const data = await res.json() as { toolCount?: number; bridgeConnected?: boolean };
    return { ok: true, toolCount: data.toolCount, bridgeConnected: data.bridgeConnected };
  } catch {
    return { ok: false };
  }
}

async function waitForHealth(retries: number, delayMs: number): Promise<{ ok: boolean; toolCount?: number; bridgeConnected?: boolean }> {
  for (let i = 0; i < retries; i++) {
    const result = await healthCheck();
    if (result.ok) return result;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false };
}

function getServerEntryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function resolveNodePath(): string {
  try {
    const cmd = platform() === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["node"], { encoding: "utf-8", timeout: 5000 }).trim();
    const firstLine = result.split("\n")[0].trim();
    if (firstLine && existsSync(firstLine)) return firstLine;
  } catch { /* fall through */ }
  return process.execPath;
}

// --- .app Wrapper (macOS Activity Monitor branding) ---

export function createAppWrapper(serverEntryPath: string): string | null {
  if (platform() !== "darwin") return null;

  const crawlioDir = join(HOME, ".crawlio");
  // The bundle path is frozen at the old product name on purpose. buildStdioEntry() returns
  // this path as the `command` written into every MCP client's config file, so it exists
  // verbatim in installed configs. Renaming the directory — or cleaning up the old one —
  // points those configs at something that is no longer there and silently breaks the server
  // for everyone who installed before the rename. Only the display name below moves.
  const appDir = join(crawlioDir, "Crawlio Agent.app");
  const contentsDir = join(appDir, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  const wrapperBin = join(macosDir, "crawlio-agent");

  try {
    mkdirSync(macosDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });
  } catch {
    return null;
  }

  // Info.plist
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Crawlio Browser</string>
  <key>CFBundleIdentifier</key>
  <string>com.crawlio.agent</string>
  <key>CFBundleExecutable</key>
  <string>crawlio-agent</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>`;

  try {
    writeFileSync(join(contentsDir, "Info.plist"), plist);
  } catch {
    return null;
  }

  // Copy icon from npm package assets/
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const iconSrc = resolve(moduleDir, "..", "..", "assets", "AppIcon.icns");
  const iconDest = join(resourcesDir, "AppIcon.icns");
  if (existsSync(iconSrc)) {
    try { copyFileSync(iconSrc, iconDest); } catch { /* non-fatal */ }
  }

  // Shell launcher script that exec's node with the server entry
  const nodePath = resolveNodePath();
  const script = `#!/bin/bash\nexec ${escapeShellSingleQuote(nodePath)} ${escapeShellSingleQuote(serverEntryPath)} "$@"\n`;

  try {
    writeFileSync(wrapperBin, script);
    chmodSync(wrapperBin, 0o755);
  } catch {
    return null;
  }

  return wrapperBin;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

function generatePlist(nodePath: string, serverPath: string): string {
  const logDir = join(HOME, "Library/Logs/Crawlio");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.crawlio.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
    <string>--portal</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/server.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
}

async function ensurePortalRunning(dryRun: boolean): Promise<void> {
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("Portal Server")}`);

  const health = await healthCheck();
  if (health.ok) {
    console.log(`    ${green("+")} Server already running on ${PORTAL_URL}`);
    return;
  }

  const serverPath = getServerEntryPath();
  const nodePath = resolveNodePath();

  if (dryRun) {
    console.log(`    ${dim("~")} Node path: ${nodePath}`);
    console.log(`    ${dim("~")} Server entry: ${serverPath}`);
    if (platform() === "darwin") {
      const plistPath = join(HOME, "Library/LaunchAgents/com.crawlio.agent.plist");
      console.log(`    ${dim("~")} Would write plist to: ${plistPath}`);
      console.log(`    ${dim("~")} Would run: launchctl load ${plistPath}`);
    } else {
      console.log(`    ${dim("~")} Would spawn detached: ${nodePath} ${serverPath} --portal`);
    }
    return;
  }

  if (platform() === "darwin") {
    const plistDir = join(HOME, "Library/LaunchAgents");
    const plistPath = join(plistDir, "com.crawlio.agent.plist");
    const logDir = join(HOME, "Library/Logs/Crawlio");

    mkdirSync(logDir, { recursive: true });
    mkdirSync(plistDir, { recursive: true });

    try {
      execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    } catch { /* not loaded */ }

    writeFileSync(plistPath, generatePlist(nodePath, serverPath));
    try {
      execFileSync("launchctl", ["load", plistPath]);
    } catch {
      return startDetachedServer(serverPath, nodePath);
    }

    const result = await waitForHealth(5, 1000);
    if (result.ok) {
      console.log(`    ${green("+")} Server running on ${PORTAL_URL}`);
      console.log(`    ${green("+")} Auto-start on login configured (launchd)`);
      return;
    }

    const portFree = await isPortFree(3001);
    if (!portFree) {
      console.log(`    ${yellow("!")} Port 3001 is already in use by another process`);
      console.log(`    ${dim("  Try: npx crawlio-browser --portal --port 3002")}`);
      return;
    }

    console.log(`    ${yellow("!")} launchd loaded but server not responding, falling back...`);
    return startDetachedServer(serverPath, nodePath);
  }

  return startDetachedServer(serverPath, nodePath);
}

async function startDetachedServer(serverPath: string, nodePath: string): Promise<void> {
  const crawlioDir = join(HOME, ".crawlio");
  mkdirSync(crawlioDir, { recursive: true });
  const pidFile = join(crawlioDir, "server.pid");

  const child = spawn(nodePath, [serverPath, "--portal"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  if (child.pid) {
    writeFileSync(pidFile, String(child.pid));
  }

  const result = await waitForHealth(5, 1000);
  if (result.ok) {
    console.log(`    ${green("+")} Server running on ${PORTAL_URL}`);
    console.log(`    ${dim("  PID saved to ~/.crawlio/server.pid")}`);
  } else {
    const portFree = await isPortFree(3001);
    if (!portFree) {
      console.log(`    ${yellow("!")} Port 3001 is already in use by another process`);
      console.log(`    ${dim("  Try: npx crawlio-browser --portal --port 3002")}`);
    } else {
      console.log(`    ${yellow("!")} Server started but health check failed — check logs`);
    }
  }
}

// --- Skill installation ---

interface SkillDef {
  name: string;
  files: string[];
}

const BUNDLED_SKILLS: SkillDef[] = [
  { name: "browser-automation", files: ["SKILL.md", "reference.md"] },
  { name: "canonical-recording", files: ["SKILL.md"] },
  { name: "robot-training", files: ["SKILL.md"] },
  { name: "web-research", files: ["SKILL.md"] },
  { name: "investigate", files: ["SKILL.md"] },
  { name: "extract", files: ["SKILL.md"] },
  { name: "compare", files: ["SKILL.md"] },
  { name: "clone", files: ["SKILL.md"] },
  { name: "dossier", files: ["SKILL.md"] },
  { name: "monitor", files: ["SKILL.md"] },
  { name: "test", files: ["SKILL.md"] },
];

export function installBrowserSkill(dryRun: boolean): void {
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("Skills")}`);

  const claudeDir = join(HOME, ".claude");
  if (!existsSync(claudeDir)) {
    console.log(`    ${dim("  i ~/.claude not found — skipping skill install")}`);
    return;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectClaudeDir = join(process.cwd(), ".claude");
  const hasProjectDir = existsSync(projectClaudeDir);

  for (const skill of BUNDLED_SKILLS) {
    const skillSrcDir = resolve(moduleDir, "..", "..", "skills", skill.name);

    if (!existsSync(join(skillSrcDir, "SKILL.md"))) {
      console.log(`    ${yellow("!")} Skill source not found at ${dim(skillSrcDir)}`);
      continue;
    }

    const userDest = join(claudeDir, "skills", skill.name);
    const projectDest = hasProjectDir ? join(projectClaudeDir, "skills", skill.name) : null;

    if (dryRun) {
      console.log(`    ${dim("~")} Would copy ${skill.files.join(" + ")} to ${userDest}`);
      if (projectDest) {
        console.log(`    ${dim("~")} Would copy ${skill.files.join(" + ")} to ${projectDest}`);
      }
      continue;
    }

    mkdirSync(userDest, { recursive: true });
    for (const file of skill.files) {
      const src = join(skillSrcDir, file);
      if (existsSync(src)) copyFileSync(src, join(userDest, file));
    }
    console.log(`    ${green("+")} Skill installed to ${dim(userDest)}`);

    if (projectDest) {
      mkdirSync(projectDest, { recursive: true });
      for (const file of skill.files) {
        const src = join(skillSrcDir, file);
        if (existsSync(src)) copyFileSync(src, join(projectDest, file));
      }
      console.log(`    ${green("+")} Skill installed to ${dim(projectDest)}`);
    }
  }
}

// --- Plugin installation (from setup.ts) ---

export function extractSkillName(relativePath: string): string | null {
  const parts = relativePath.split(/[/\\]/);
  // Expected: ["skills", "<name>", "SKILL.md"]
  if (parts.length < 3 || parts[0] !== "skills") return null;
  return parts[1];
}

function installPlugin(dryRun: boolean): void {
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("Plugins")}`);

  const pluginsDir = join(HOME, ".crawlio", "plugins");
  const pluginDir = join(pluginsDir, "crawlio-plugin");

  if (dryRun) {
    console.log(`    ${dim("~")} Plugin target: ${pluginDir}`);
    console.log(`    ${dim("~")} Would clone: https://github.com/Crawlio-app/crawlio-plugin.git`);
    return;
  }

  mkdirSync(pluginsDir, { recursive: true });

  if (existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) {
    console.log(`    ${green("+")} Plugin already installed at ${dim(pluginDir)}`);
    try {
      execFileSync("git", ["-C", pluginDir, "pull", "--ff-only"], { stdio: "ignore", timeout: 15_000 });
      console.log(`    ${green("+")} Updated to latest`);
    } catch { /* offline or not a git repo */ }
  } else {
    try {
      execFileSync("git", ["clone", "https://github.com/Crawlio-app/crawlio-plugin.git", pluginDir], {
        timeout: 30_000,
        stdio: "pipe",
      });
      console.log(`    ${green("+")} Cloned to ${dim(pluginDir)}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`    ${yellow("!")} Clone failed: ${msg.slice(0, 150)}`);
      return;
    }
  }

  if (existsSync(join(HOME, ".claude"))) {
    // Copy skills (preserving directory structure)
    const claudeSkillsDir = join(HOME, ".claude", "skills");
    mkdirSync(claudeSkillsDir, { recursive: true });
    try {
      const allFiles = readdirSync(pluginDir, { recursive: true, encoding: "utf-8" });
      const skillFiles = allFiles.filter(
        (f) => f.includes(`skills${sep}`) && f.endsWith(".md")
      );

      const installedSkills: string[] = [];
      for (const relative of skillFiles) {
        const skillName = extractSkillName(relative);
        if (!skillName) continue;
        const fileName = basename(relative);
        const destDir = join(claudeSkillsDir, skillName);
        mkdirSync(destDir, { recursive: true });
        writeFileSync(join(destDir, fileName), readFileSync(join(pluginDir, relative), "utf-8"));
        installedSkills.push(skillName);
      }
      if (installedSkills.length > 0) {
        console.log(`    ${green("+")} ${installedSkills.length} skills copied to ${dim(claudeSkillsDir)} (${installedSkills.join(", ")})`);
      }
    } catch { /* no skills found */ }

    // Copy agents
    const agentsSrcDir = join(pluginDir, "agents");
    if (existsSync(agentsSrcDir)) {
      const agentsDestDir = join(HOME, ".claude", "agents");
      mkdirSync(agentsDestDir, { recursive: true });
      const agentFiles = readdirSync(agentsSrcDir, { encoding: "utf-8" })
        .filter(f => f.endsWith(".md"));
      for (const file of agentFiles) {
        copyFileSync(join(agentsSrcDir, file), join(agentsDestDir, file));
      }
      if (agentFiles.length > 0) {
        console.log(`    ${green("+")} ${agentFiles.length} agent(s) copied to ${dim(agentsDestDir)}`);
      }
    }
  }
}

// --- Interactive text input ---

async function promptInput(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`    ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// --- Cloudflare helpers ---

interface CloudflareAccount {
  id: string;
  name: string;
}

export async function verifyCloudflareToken(apiToken: string): Promise<{
  ok: boolean;
  accounts?: CloudflareAccount[];
  error?: string;
}> {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} — check token permissions` };
    }
    const data = (await res.json()) as {
      success: boolean;
      errors?: Array<{ message: string }>;
      result?: Array<{ id: string; name: string }>;
    };
    if (!data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Unknown error" };
    }
    return {
      ok: true,
      accounts: (data.result || []).map((a) => ({ id: a.id, name: a.name })),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Flow: cloudflare ---

async function cloudflareFlow(options: InitOptions): Promise<void> {
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("Cloudflare Integration")}`);
  console.log(`    ${dim("Workers, KV, D1, R2, Queues, AI — 89 tools via MCP")}`);
  console.log("");

  // 1. Get API token (env var or interactive prompt)
  let apiToken = process.env.CLOUDFLARE_API_TOKEN || "";

  if (apiToken) {
    console.log(`    ${green("+")} Found CLOUDFLARE_API_TOKEN in environment`);
  } else {
    console.log(`    ${dim("Create a token at:")} ${cyan("https://dash.cloudflare.com/profile/api-tokens")}`);
    console.log(`    ${dim("Recommended template: 'Edit Cloudflare Workers'")}`);
    console.log("");

    if (options.dryRun) {
      console.log(`    ${dim("~")} Would prompt for API token`);
      return;
    }

    apiToken = await promptInput("API Token:");

    if (!apiToken) {
      console.log(`    ${yellow("!")} No token provided — skipping Cloudflare setup`);
      return;
    }
  }

  // 2. Verify token against Cloudflare API
  const mask = apiToken.length > 12
    ? apiToken.slice(0, 8) + "..." + apiToken.slice(-4)
    : "***";
  console.log(`    ${dim("Verifying")} ${dim(mask)}`);

  const verification = await verifyCloudflareToken(apiToken);
  if (!verification.ok) {
    console.log(`    ${yellow("!")} Token verification failed: ${verification.error}`);
    return;
  }

  if (!verification.accounts || verification.accounts.length === 0) {
    console.log(`    ${yellow("!")} No accounts found for this token`);
    return;
  }

  // 3. Select account (auto if single, prompt if multiple)
  let account: CloudflareAccount;

  if (verification.accounts.length === 1) {
    account = verification.accounts[0];
  } else {
    console.log("");
    console.log(`    Found ${verification.accounts.length} accounts:`);
    for (let i = 0; i < verification.accounts.length; i++) {
      const a = verification.accounts[i];
      console.log(`      ${dim(`${i + 1}.`)} ${a.name} ${dim(`(${a.id.slice(0, 8)}...)`)}`);
    }

    // Check env var for pre-selected account
    const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
    const envMatch = envAccountId
      ? verification.accounts.find((a) => a.id === envAccountId)
      : null;

    if (envMatch) {
      account = envMatch;
      console.log(`    ${green("+")} Using CLOUDFLARE_ACCOUNT_ID from environment`);
    } else if (options.yes) {
      account = verification.accounts[0];
    } else {
      const choice = await promptInput(`Select account [1-${verification.accounts.length}]:`);
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= verification.accounts.length) {
        account = verification.accounts[0];
        console.log(`    ${dim("Using first account")}`);
      } else {
        account = verification.accounts[idx];
      }
    }
  }

  console.log(`    ${green("+")} ${account.name} ${dim(`(${account.id.slice(0, 8)}...)`)}`);

  // 4. Build and write config entry
  const entry = buildCloudflareEntry(account.id, apiToken);

  if (options.dryRun) {
    console.log(`    ${dim("~")} Would add cloudflare MCP server with 89 tools`);
    console.log(`    ${dim("~")} Account: ${account.name} (${account.id})`);
    return;
  }

  const mcpConfig = findMcpConfig();
  if (mcpConfig) {
    if (isCloudflareConfigured(mcpConfig.config)) {
      const overwrite = options.yes || await confirm("Cloudflare already configured. Overwrite?", false);
      if (!overwrite) {
        console.log(`    ${dim("Kept existing configuration")}`);
        return;
      }
      // Clean up legacy entries
      delete mcpConfig.config.mcpServers["cloudflare-bindings"];
      delete mcpConfig.config.mcpServers["cloudflare-builds"];
    }
    mcpConfig.config.mcpServers["cloudflare"] = entry as unknown as Record<string, unknown>;
    atomicWriteSync(mcpConfig.path, JSON.stringify(mcpConfig.config, null, 2) + "\n");
    console.log(`    ${green("+")} Added cloudflare to ${mcpConfig.path}`);
  } else {
    // No .mcp.json found — create one
    const configPath = join(process.cwd(), ".mcp.json");
    const config = { mcpServers: { cloudflare: entry } };
    atomicWriteSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`    ${green("+")} Created ${configPath} with cloudflare`);
  }

  console.log(`    ${green("+")} 89 Cloudflare tools ready (Workers, KV, D1, R2, Queues, AI)`);
}

// --- Flow: portal ---

async function portalFlow(options: InitOptions): Promise<void> {
  await ensurePortalRunning(options.dryRun);
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("MCP Configuration")} ${dim("(portal mode)")}`);
  configureAllClients(options);
}

// --- Flow: .mcp.json detected ---

async function configureMetaMcp(found: McpConfigResult, options: InitOptions): Promise<void> {
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("MCP Configuration")} ${dim("(.mcp.json)")}`);

  if (isAlreadyConfigured(found.config)) {
    console.log(`    ${green("+")} crawlio-browser already configured in ${dim(found.path)}`);
    return;
  }

  // Info: check if another config location already has crawlio-browser
  const conflicts = findConflictingConfigs();
  if (conflicts.length > 0) {
    console.log(`    ${dim("i")} crawlio-browser also configured in:`);
    for (const c of conflicts) {
      console.log(`      ${dim("→")} ${c}`);
    }
    console.log(`    ${dim("  Multi-instance supported — each server gets its own port (9333-9342)")}`);
  }

  if (!options.yes) {
    const proceed = await confirm("Add crawlio-browser to this config?");
    if (!proceed) {
      console.log(`    ${dim("Skipped")}`);
      return;
    }
  }

  const entry = options.portal ? buildPortalEntry() : buildStdioEntry({ full: options.full, dryRun: options.dryRun });

  if (options.dryRun) {
    console.log(`    ${dim("~")} Would add to ${found.path}:`);
    console.log(`    ${dim("~")} "crawlio-browser": ${JSON.stringify(entry)}`);
    return;
  }

  found.config.mcpServers["crawlio-browser"] = entry;
  atomicWriteSync(found.path, JSON.stringify(found.config, null, 2) + "\n");
  console.log(`    ${green("+")} Added crawlio-browser to ${found.path}`);
}

// --- Flow: stdio (default) ---

function configureStdioClients(options: InitOptions): void {
  console.log("");
  console.log(`  ${cyan("◆")} ${bold("MCP Configuration")} ${dim("(stdio mode)")}`);
  configureAllClients(options);
}

// --- Summary ---

const LOGO_LINES = [
  " ██████╗ ██████╗   █████╗  ██╗    ██╗ ██╗      ██╗  ██████╗ ",
  "██╔════╝ ██╔══██╗ ██╔══██╗ ██║    ██║ ██║      ██║ ██╔═══██╗",
  "██║      ██████╔╝ ███████║ ██║ █╗ ██║ ██║      ██║ ██║   ██║",
  "██║      ██╔══██╗ ██╔══██║ ██║███╗██║ ██║      ██║ ██║   ██║",
  "╚██████╗ ██║  ██║ ██║  ██║ ╚███╔███╔╝ ███████╗ ██║ ╚██████╔╝",
  " ╚═════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚══╝╚══╝  ╚══════╝ ╚═╝  ╚═════╝",
];

function printBanner(): void {
  console.log("");
  for (let i = 0; i < LOGO_LINES.length; i++) {
    console.log(`  ${LOGO_GRADIENT[i]}${LOGO_LINES[i]}${RESET}`);
  }
  console.log("");
  console.log(`  ${dim("Browser automation via MCP")}  ${dim("·")}  ${dim("v" + VERSION)}`);
  console.log("");
}

function printRule(): void {
  console.log(`  ${dim("─".repeat(56))}`);
}

function printBox(title: string, lines: string[], footer?: { title: string; lines: string[] }): void {
  const width = 56;
  const border = (s: string) => cyan(s);

  console.log(`  ${border("┌─")} ${bold(title)} ${border("─".repeat(Math.max(0, width - title.length - 4)))}${border("┐")}`);
  console.log(`  ${border("│")}${" ".repeat(width)}${border("│")}`);

  for (const line of lines) {
    const padding = Math.max(0, width - stripAnsi(line).length);
    console.log(`  ${border("│")}  ${line}${" ".repeat(padding - 2)}${border("│")}`);
  }

  console.log(`  ${border("│")}${" ".repeat(width)}${border("│")}`);

  if (footer) {
    console.log(`  ${border("├─")} ${bold(footer.title)} ${border("─".repeat(Math.max(0, width - footer.title.length - 4)))}${border("┤")}`);
    console.log(`  ${border("│")}${" ".repeat(width)}${border("│")}`);

    for (const line of footer.lines) {
      const padding = Math.max(0, width - stripAnsi(line).length);
      console.log(`  ${border("│")}  ${line}${" ".repeat(padding - 2)}${border("│")}`);
    }

    console.log(`  ${border("│")}${" ".repeat(width)}${border("│")}`);
  }

  console.log(`  ${border("└")}${border("─".repeat(width))}${border("┘")}`);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function printSummary(options: InitOptions): Promise<void> {
  console.log("");

  const statusLines: string[] = [];

  if (options.portal) {
    const health = await healthCheck();
    if (health.ok) {
      statusLines.push(`${green("+")} Mode        Portal (${health.toolCount ?? "?"} tools)`);
    } else {
      statusLines.push(`${yellow("!")} Portal      Not responding`);
    }
    if (health.bridgeConnected) {
      statusLines.push(`${green("+")} Extension   Connected`);
    } else {
      statusLines.push(`${dim("i")} Extension   Not connected yet`);
    }
  } else {
    const modeLabel = options.full ? "Full mode" : "Code mode";
    // Counted, not quoted. This line is the last thing an installer reads, and it spent several
    // releases claiming 114 tools in full mode and 3 in code mode when the real numbers were
    // 145 and 6. Imported lazily so the tool builders load only when this summary is printed.
    const { describeSurface } = await import("./surface.js");
    const surface = await describeSurface();
    const countLabel = options.full
      ? `(${surface.full.length} tools)`
      : `(${surface.code.length} tools, ${surface.catalog.total} commands)`;
    statusLines.push(`${green("+")} Mode        ${modeLabel} ${countLabel}`);
  }

  statusLines.push(`${green("+")} Skill       Browser automation installed`);
  statusLines.push(`${green("+")} Extension   ${cyan("https://www.crawlio.app/browser-agent")}`);
  statusLines.push(`${dim("i")} Health      npx crawlio-browser doctor`);

  if (options.cloudflare) {
    const mcpCfg = findMcpConfig();
    if (mcpCfg && "cloudflare" in mcpCfg.config.mcpServers) {
      statusLines.push(`${green("+")} Cloudflare  89 tools (Workers, KV, D1, R2)`);
    } else {
      statusLines.push(`${yellow("!")} Cloudflare  Not configured`);
    }
  }

  const nextLines: string[] = [];
  nextLines.push(`1. Install the Chrome extension`);
  nextLines.push(`2. Open any MCP client (Claude Code, Cursor, etc.)`);
  nextLines.push(`3. Ask your AI to use crawlio-browser tools`);
  nextLines.push(``);
  if (!options.portal) {
    nextLines.push(`${dim("Tip: use --portal for multi-client or ChatGPT Desktop")}`);
  } else {
    nextLines.push(`${dim("Tip: portal running at " + PORTAL_URL)}`);
  }

  printBox("Setup Complete", statusLines, { title: "What's Next", lines: nextLines });
  console.log("");
}

// --- Main entry ---

/**
 * Best-effort install of the native-messaging host: lets the extension be
 * handed the real bridge token over Chrome's authenticated channel so it can refuse
 * rogue local servers. Never fails init — a missing browser profile / perms just skips.
 */
function installNativeMessagingHost(dryRun: boolean): void {
  if (dryRun) {
    console.log(`    ${dim("◇ would install the native-messaging host (server identity verification)")}`);
    return;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const installScript = resolve(here, "..", "..", "bin", "native-host", "install.mjs");
    if (!existsSync(installScript)) return; // not present in this layout — skip silently
    execFileSync(process.execPath, [installScript], { stdio: "pipe" });
    console.log(`    ${green("+")} Native-messaging host installed ${dim("(server identity verification)")}`);
  } catch (err) {
    console.log(`    ${dim("  native-messaging host skipped (optional): " + (err instanceof Error ? err.message : String(err)))}`);
  }
}

export async function runInit(argv: string[]): Promise<void> {
  const options = parseFlags(argv);
  // Agent/script-runnable: a non-interactive stdin (piped, CI, an agent spawning init) means
  // no human is here to answer prompts — behave as --yes so onboarding never blocks. confirm()
  // already returns its default in non-TTY; this makes the intent explicit for every prompt.
  if (!process.stdin.isTTY) options.yes = true;

  printBanner();
  printRule();

  if (options.dryRun) {
    console.log(`  ${yellow("◇")} ${bold(yellow("Dry Run"))} ${dim("— showing what init would do without executing")}`);
    console.log("");
  }

  // Preflight
  console.log(`  ${cyan("◆")} ${bold("Preflight")}`);
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 18) {
    console.log(`    ${yellow("!")} Node.js ${process.versions.node} — 18+ required`);
    console.log(`    ${dim("  Install via: https://nodejs.org")}`);
    process.exit(1);
  }
  console.log(`    ${green("+")} Node.js ${process.versions.node} — OK`);

  if (options.portal) {
    await portalFlow(options);
  } else {
    const mcpConfig = findMcpConfig();
    if (mcpConfig) {
      await configureMetaMcp(mcpConfig, options);
    } else {
      configureStdioClients(options);
    }
  }

  installBrowserSkill(options.dryRun);
  installNativeMessagingHost(options.dryRun);

  if (options.plugin) {
    installPlugin(options.dryRun);
  }

  if (options.cloudflare) {
    await cloudflareFlow(options);
  }

  printRule();
  await printSummary(options);

  // Anonymous usage analytics — install id + aggregate counts only, NEVER page data or PII.
  // Disclosed here; opt out with CRAWLIO_TELEMETRY=0 (see TELEMETRY.md). Fire-and-forget.
  if (!options.dryRun) {
    getInstallId(); // ensure the anonymous install id exists (~/.crawlio/install-id)
    pingInstall();
    if (telemetryEnabled()) {
      console.log(`  ${dim("Anonymous usage analytics on (install id only, no page data). Opt out: CRAWLIO_TELEMETRY=0 · TELEMETRY.md")}`);
    }
  }
}
