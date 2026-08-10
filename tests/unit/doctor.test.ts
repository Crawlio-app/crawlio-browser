import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectDoctorReport,
  exitCodeFor,
  renderDoctorReport,
  type DoctorDeps,
  type DoctorReport,
  type DoctorCheck,
} from "../../src/mcp-server/doctor.js";
import { redactSecrets } from "../../src/mcp-server/redact.js";
import type { McpClientDef } from "../../src/mcp-server/init.js";

const SECRET_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef";

/** A bridges dir with one live-pid bridge file (our own pid is always alive). */
function makeBridgesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-bridges-"));
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({ port: 9333, token: SECRET_TOKEN, pid: process.pid, startedAt: 1, lastActivityAt: Date.now() }),
  );
  return dir;
}

function bridgeHealthFetch(connected: boolean): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes(":9333/health")) {
      return {
        ok: true,
        json: async () => ({ service: "crawlio-mcp", pid: process.pid, port: 9333, connected, uptime: 12, queueDepth: 0, version: "1.6.6" }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}


/** Bridge health that also reports what the extension says it holds. */
function permissionHealthFetch(extensionPermissions: unknown): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes(":9333/health")) {
      return {
        ok: true,
        json: async () => ({
          service: "crawlio-mcp", pid: process.pid, port: 9333, connected: true,
          uptime: 12, queueDepth: 0, version: "1.9.5",
          ...(extensionPermissions === undefined ? {} : { extensionPermissions }),
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

/** Deps where every core check can reach a healthy state, portal deliberately down. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const nmDir = mkdtempSync(join(tmpdir(), "doctor-nm-"));
  writeFileSync(join(nmDir, "com.crawlio.agent.json"), "{}");
  const staged = join(nmDir, "host.mjs");
  writeFileSync(staged, "// staged host");
  const clientDir = mkdtempSync(join(tmpdir(), "doctor-client-"));
  const configPath = join(clientDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { "crawlio-browser": { command: "npx" } } }));
  const registry: McpClientDef[] = [
    { name: "FakeClient", configPath, serverKey: "mcpServers", format: "json", detect: () => true },
  ];
  return {
    bridgesDir: makeBridgesDir(),
    fetchFn: bridgeHealthFetch(true),
    portalUrl: "http://127.0.0.1:3999",
    portFree: async () => true,
    appIsRunning: async () => true,
    appSocketPaths: [],
    registry,
    hostDirs: () => [nmDir],
    stagedHostPath: staged,
    launchdPlistPath: join(nmDir, "absent.plist"),
    ...overrides,
  };
}

function check(report: DoctorReport, id: string): DoctorCheck {
  const c = report.checks.find((x) => x.id === id);
  expect(c, `check ${id} must exist`).toBeDefined();
  return c as DoctorCheck;
}

describe("doctor — collect", () => {
  it("reaches ok on every reachable check under a healthy fake environment", async () => {
    const report = await collectDoctorReport(healthyDeps());
    expect(report.schema).toBe("ai.crawlio.browser-doctor.v1");
    expect(check(report, "bridge.servers").status).toBe("ok");
    expect(check(report, "nativehost.manifests").status).toBe("ok");
    expect(check(report, "clients.configs").status).toBe("ok");
    expect(check(report, "crawlio.app").status).toBe("ok");
    // Portal is legitimately off in a stdio-only setup — never an error here.
    expect(check(report, "portal.health").status).toBe("off");
    expect(exitCodeFor(report)).toBe(0);
    expect(report.summary.ok).toBe(4);
    expect(report.summary.off).toBe(1);
  });

  it("degrades to warn when servers run but no extension is connected", async () => {
    const report = await collectDoctorReport(healthyDeps({ fetchFn: bridgeHealthFetch(false) }));
    const bridge = check(report, "bridge.servers");
    expect(bridge.status).toBe("warn");
    expect(bridge.fix).toContain("extension");
    expect(exitCodeFor(report)).toBe(1);
  });

  it("reports error for live bridge files that no server backs", async () => {
    const failFetch = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    const report = await collectDoctorReport(healthyDeps({ fetchFn: failFetch }));
    expect(check(report, "bridge.servers").status).toBe("error");
  });

  it("marks unparseable json and toml configs as configured: unknown", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "doctor-badcfg-"));
    const badJson = join(clientDir, "bad.json");
    writeFileSync(badJson, "{not json");
    const toml = join(clientDir, "config.toml");
    writeFileSync(toml, `[mcp_servers.crawlio-browser]\ncommand = "npx"\n`);
    const registry: McpClientDef[] = [
      { name: "BadJson", configPath: badJson, serverKey: "mcpServers", format: "json", detect: () => true },
      { name: "TomlClient", configPath: toml, serverKey: "mcp_servers", format: "toml", detect: () => true },
    ];
    const report = await collectDoctorReport(healthyDeps({ registry }));
    const rows = check(report, "clients.configs").evidence.clients as Array<{ client: string; configured: unknown }>;
    expect(rows.find((r) => r.client === "BadJson")?.configured).toBe("unknown");
    expect(rows.find((r) => r.client === "TomlClient")?.configured).toBe("unknown");
  });

  it("collect never writes to the bridges dir (side-effect-free)", async () => {
    const deps = healthyDeps();
    const dir = deps.bridgesDir as string;
    const before = readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs] as const);
    await collectDoctorReport(deps);
    const after = readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs] as const);
    expect(after).toEqual(before);
  });

  it("reports crawlio.app ok over UDS when a socket answers /health", async () => {
    const report = await collectDoctorReport(healthyDeps({
      appSocketPaths: ["/fake/c.sock", "/fake/control.sock"],
      fileExists: (p) => p === "/fake/c.sock",
      udsHealth: async (p) => p === "/fake/c.sock",
      appIsRunning: async () => false,
    }));
    const app = check(report, "crawlio.app");
    expect(app.status).toBe("ok");
    expect(app.evidence.transport).toBe("uds");
    expect(app.evidence.socketPath).toBe("/fake/c.sock");
  });

  it("reports a stale socket honestly when it exists but does not answer", async () => {
    const report = await collectDoctorReport(healthyDeps({
      appSocketPaths: ["/fake/control.sock"],
      fileExists: (p) => p === "/fake/control.sock",
      udsHealth: async () => false,
      appIsRunning: async () => false,
    }));
    const app = check(report, "crawlio.app");
    expect(app.status).toBe("off");
    expect(app.detail).toContain("stale socket");
    expect(app.evidence.socketExists).toBe(true);
  });

  it("falls back to the TCP port-file probe when no socket exists", async () => {
    const report = await collectDoctorReport(healthyDeps({
      appSocketPaths: ["/fake/control.sock"],
      fileExists: () => false,
      udsHealth: async () => {
        throw new Error("udsHealth must not run when no socket file exists");
      },
      appIsRunning: async () => true,
    }));
    const app = check(report, "crawlio.app");
    expect(app.status).toBe("ok");
    expect(app.evidence.transport).toBe("tcp");
  });
});

describe("doctor — redaction", () => {
  it("the bridge token never survives into report output", async () => {
    const report = await collectDoctorReport(healthyDeps());
    const raw = JSON.stringify(report);
    expect(raw).not.toContain(SECRET_TOKEN); // never copied into evidence at all
    const redacted = JSON.stringify(redactSecrets(report));
    expect(redacted).not.toContain(SECRET_TOKEN); // belt-and-braces boundary
  });
});

describe("doctor — exit taxonomy", () => {
  function fabricate(bridge: DoctorCheck["status"], portal: DoctorCheck["status"], opts: { bridgeConnected?: boolean; extraError?: boolean } = {}): DoctorReport {
    const checks: DoctorCheck[] = [
      { id: "bridge.servers", status: bridge, detail: "", evidence: {} },
      { id: "portal.health", status: portal, detail: "", evidence: { bridgeConnected: opts.bridgeConnected ?? false } },
      { id: "nativehost.manifests", status: opts.extraError ? "error" : "ok", detail: "", evidence: {} },
    ];
    const summary = { ok: 0, warn: 0, off: 0, error: 0 } as DoctorReport["summary"];
    for (const c of checks) summary[c.status] += 1;
    return { schema: "ai.crawlio.browser-doctor.v1", generatedAt: "", version: "0", checks, summary };
  }

  it("69 when nothing serves MCP", () => {
    expect(exitCodeFor(fabricate("off", "off"))).toBe(69);
    expect(exitCodeFor(fabricate("error", "off"))).toBe(69);
  });
  it("0 when a bridge has the extension connected", () => {
    expect(exitCodeFor(fabricate("ok", "off"))).toBe(0);
  });
  it("0 when the portal reports the extension connected", () => {
    expect(exitCodeFor(fabricate("off", "ok", { bridgeConnected: true }))).toBe(0);
  });
  it("1 when a server is up but the extension is not connected", () => {
    expect(exitCodeFor(fabricate("warn", "off"))).toBe(1);
    expect(exitCodeFor(fabricate("off", "ok", { bridgeConnected: false }))).toBe(1);
  });
  it("1 when connected but any check errored", () => {
    expect(exitCodeFor(fabricate("ok", "off", { extraError: true }))).toBe(1);
  });
});

describe("doctor — render", () => {
  it("lists every check id, shows fixes for non-ok checks, and prints a verdict", async () => {
    const report = await collectDoctorReport(healthyDeps({ fetchFn: bridgeHealthFetch(false) }));
    const text = renderDoctorReport(report);
    for (const c of report.checks) expect(text).toContain(c.id);
    expect(text).toContain("fix:");
    expect(text).toContain("degraded");
    expect(text).toContain("--json");
  });

  // A partial grant is invisible to every other check: browsing works, so bridge/portal/native
  // host all report ok while the extension cannot verify which local server it is talking to.
  describe("extension.permissions", () => {
    const find = (r: Awaited<ReturnType<typeof collectDoctorReport>>) =>
      r.checks.find((c) => c.id === "extension.permissions")!;

    it("is ok when the extension holds everything", async () => {
      const report = await collectDoctorReport(healthyDeps({
        fetchFn: permissionHealthFetch({ granted: true, permissions: { tabs: true, nativeMessaging: true }, missing: [] }),
      }));
      const check = find(report);
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("nativeMessaging");
    });

    it("warns, and says why it matters, when nativeMessaging is the missing one", async () => {
      const report = await collectDoctorReport(healthyDeps({
        fetchFn: permissionHealthFetch({ granted: false, permissions: { tabs: true, nativeMessaging: false }, missing: ["nativeMessaging"] }),
      }));
      const check = find(report);
      expect(check.status).toBe("warn");
      expect(check.detail).toMatch(/cannot verify which local server/);
      expect(check.fix).toMatch(/dedicated onboarding page/i);
      expect(check.fix).not.toMatch(/badge|popup|widget/i);
    });

    it("warns when an older extension reports nothing, rather than claiming ok", async () => {
      const report = await collectDoctorReport(healthyDeps({ fetchFn: permissionHealthFetch(undefined) }));
      const check = find(report);
      expect(check.status).toBe("warn");
      expect(check.fix).toMatch(/[Rr]eload/);
    });

    it("is off, not failing, when no extension is connected", async () => {
      const report = await collectDoctorReport(healthyDeps({ fetchFn: bridgeHealthFetch(false) }));
      expect(find(report).status).toBe("off");
    });
  });

});
