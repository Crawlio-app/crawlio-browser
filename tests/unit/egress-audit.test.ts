import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  DECLARED_EGRESS,
  DECLARED_EXTENSION_SURFACE,
  collectEgressAudit,
  renderEgressAudit,
  readJsonFile,
  type EgressClass,
} from "../../src/mcp-server/egress-audit.js";

const VALID_CLASSES: EgressClass[] = ["unsolicited", "user-initiated", "target-directed", "local"];

describe("egress audit — the declared surface is complete and honest", () => {
  it("every entry declares a valid class and all four fields", () => {
    expect(DECLARED_EGRESS.length).toBeGreaterThan(0);
    for (const e of DECLARED_EGRESS) {
      expect(VALID_CLASSES).toContain(e.klass);
      for (const field of ["host", "purpose", "carries", "control"] as const) {
        expect(e[field], `${e.host}.${field}`).toBeTruthy();
      }
    }
  });

  it("telemetry is declared UNSOLICITED and admits the endpoint sees your IP", () => {
    const telemetry = DECLARED_EGRESS.find((e) => e.host.includes("worker.crawlio.app"));
    expect(telemetry, "the telemetry endpoint must be declared").toBeDefined();
    expect(telemetry!.klass).toBe("unsolicited");
    // Guards the TELEMETRY.md correction: the payload being anonymous is not the whole exposure.
    // If someone removes this admission, the audit has started lying again.
    expect(telemetry!.carries.toLowerCase()).toMatch(/\bip\b/);
    expect(telemetry!.control).toContain("CRAWLIO_TELEMETRY=0");
  });

  it("the Cloudflare API is user-initiated, never unsolicited", () => {
    const cf = DECLARED_EGRESS.find((e) => e.host.includes("api.cloudflare.com"));
    expect(cf).toBeDefined();
    expect(cf!.klass).toBe("user-initiated");
  });

  it("telemetry is the ONLY unsolicited destination", () => {
    // A new unsolicited host must be a deliberate, reviewed act — not something that slips in.
    const unsolicited = DECLARED_EGRESS.filter((e) => e.klass === "unsolicited").map((e) => e.host);
    expect(unsolicited).toEqual(["worker.crawlio.app"]);
  });

  it("declares that ControlServer requests carry a local capability without leaving loopback", () => {
    const control = DECLARED_EGRESS.find((e) => e.host.includes("Crawlio.app control server"));
    expect(control?.klass).toBe("local");
    expect(control?.carries).toMatch(/local-user MCP capability/i);
    expect(control?.carries).toMatch(/nothing leaves/i);
  });
});

describe("egress audit — declaration matches what we actually ship", () => {
  // The whole value of a declared table is that it cannot drift from reality unnoticed.
  const manifestPath = fileURLToPath(
    new URL("../../src/extension/manifest.prod.json", import.meta.url),
  );
  const manifest = readJsonFile<{
    permissions?: string[];
    host_permissions?: string[];
    optional_permissions?: string[];
    optional_host_permissions?: string[];
  }>(manifestPath);

  it("the extension manifest is readable", () => {
    expect(manifest, `could not read ${manifestPath}`).not.toBeNull();
  });

  it("declared permissions match manifest.prod.json exactly", () => {
    expect([...DECLARED_EXTENSION_SURFACE.permissions].sort()).toEqual(
      [...(manifest?.permissions ?? [])].sort(),
    );
  });

  it("declared host permissions match — and the extension still has none", () => {
    expect([...DECLARED_EXTENSION_SURFACE.host_permissions].sort()).toEqual(
      [...(manifest?.host_permissions ?? [])].sort(),
    );
    // Standing host access would be a materially different privacy posture; make it loud.
    expect(manifest?.host_permissions ?? []).toEqual([]);
  });

  it("declared optional host access matches", () => {
    expect([...DECLARED_EXTENSION_SURFACE.optional_host_permissions].sort()).toEqual(
      [...(manifest?.optional_host_permissions ?? [])].sort(),
    );
  });

  it("declared optional permissions match", () => {
    expect([...DECLARED_EXTENSION_SURFACE.optional_permissions].sort()).toEqual(
      [...(manifest?.optional_permissions ?? [])].sort(),
    );
  });
});

describe("egress audit — report and rendering", () => {
  it("collects a report without touching the network", () => {
    const r = collectEgressAudit();
    expect(r.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(r.installIdFile).toContain(".crawlio");
    expect(r.telemetryEndpoint).toMatch(/^https?:\/\//);
    expect(r.egress).toBe(DECLARED_EGRESS);
  });

  it("renders the id, the telemetry state, and the unsolicited summary", () => {
    const out = renderEgressAudit(collectEgressAudit());
    expect(out).toContain(collectEgressAudit().installId);
    expect(out).toContain("worker.crawlio.app");
    expect(out).toContain("unsolicited");
    expect(out).toMatch(/rotate/i);
    // The honesty clause has to reach the user, not just the source.
    expect(out).toMatch(/correlatable/i);
  });

  it("renders every declared host", () => {
    const out = renderEgressAudit(collectEgressAudit());
    for (const e of DECLARED_EGRESS) expect(out).toContain(e.host);
  });
});
