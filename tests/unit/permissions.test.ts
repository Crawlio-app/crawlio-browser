import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_OPTIONAL_PERMISSIONS,
  declaredOptionalPermissions,
  declaredRequiredPermissions,
  missingPermissions,
  isComplete,
} from "../../src/shared/permissions.js";

const ROOT = join(__dirname, "../..");

/**
 * Keep the Chrome Web Store install floor small while making onboarding the one deliberate place
 * that acquires every optional capability declared by the running build.
 */
describe("optional permission set", () => {
  it("keeps the production manifest at the audited permission floor", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "src/extension/manifest.prod.json"), "utf-8"));
    expect(manifest.permissions).toEqual(["alarms", "debugger", "storage"]);
    expect(manifest.optional_permissions).toEqual(CORE_OPTIONAL_PERMISSIONS.permissions);
    expect(manifest.optional_host_permissions).toEqual(CORE_OPTIONAL_PERMISSIONS.origins);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest.optional_permissions).not.toEqual(expect.arrayContaining([
      "activeTab", "tabGroups", "unlimitedStorage",
    ]));
  });

  it("covers everything the core flow needs", () => {
    expect(CORE_OPTIONAL_PERMISSIONS.permissions).toEqual(["tabs", "nativeMessaging"]);
    expect(CORE_OPTIONAL_PERMISSIONS.origins).toEqual(["http://127.0.0.1/*"]);
  });

  it("keeps development diagnostics optional and includes secure bridge setup", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "src/extension/manifest.dev.json"), "utf-8"));
    expect(manifest.permissions).toEqual(["alarms", "debugger", "storage"]);
    expect(manifest.optional_permissions).toEqual([
      "tabs", "nativeMessaging", "history", "downloads", "contextMenus",
    ]);
    expect(manifest.optional_host_permissions).toEqual(["http://127.0.0.1/*"]);
  });

  it("requests no wildcard host — that is the CWS review trigger the strategy avoids", () => {
    for (const origin of CORE_OPTIONAL_PERMISSIONS.origins ?? []) {
      expect(origin).not.toMatch(/^\*|\/\/\*/);
      expect(origin).toContain("127.0.0.1");
    }
  });

  it("declares nothing that Chrome forbids from being optional", () => {
    // Chrome hardcodes these as non-optional; declaring one here would break the install.
    const cannotBeOptional = ["debugger", "declarativeNetRequest", "devtools", "geolocation", "proxy", "tts", "ttsEngine"];
    for (const p of CORE_OPTIONAL_PERMISSIONS.permissions ?? []) {
      expect(cannotBeOptional).not.toContain(p);
    }
  });
});

describe("manifest-derived permission surfaces", () => {
  it("derives required reporting and the complete onboarding request from the active manifest", () => {
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: vi.fn(() => ({
          permissions: ["alarms", "debugger", "storage"],
          optional_permissions: ["tabs", "nativeMessaging", "history"],
          optional_host_permissions: ["http://127.0.0.1/*"],
        })),
      },
    });

    expect(declaredRequiredPermissions()).toEqual(["alarms", "debugger", "storage"]);
    expect(declaredOptionalPermissions()).toEqual({
      permissions: ["tabs", "nativeMessaging", "history"],
      origins: ["http://127.0.0.1/*"],
    });
  });
});

describe("missingPermissions", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn((query: chrome.permissions.Permissions, cb: (ok: boolean) => void) => {
          // Everything granted except nativeMessaging — the exact state after the old
          // onboarding, which asked for tabs and the origin but not the native channel.
          const asksForNative = (query.permissions ?? []).includes("nativeMessaging");
          cb(!asksForNative);
        }),
      },
    });
  });

  it("returns only the outstanding entries, never the whole set", async () => {
    const missing = await missingPermissions();
    // Narrowing is what keeps a denial from revoking an already-held grant, because
    // chrome.permissions.request() is all-or-nothing.
    expect(missing.permissions).toEqual(["nativeMessaging"]);
    expect(missing.origins).toEqual([]);
    expect(isComplete(missing)).toBe(false);
  });

  it("reports completion when nothing is outstanding", async () => {
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn((_q: unknown, cb: (ok: boolean) => void) => cb(true)) },
    });
    const missing = await missingPermissions();
    expect(isComplete(missing)).toBe(true);
  });
});

describe("onboarding-only permission acquisition", () => {
  it("makes welcome.ts the sole extension source allowed to call permissions.request", () => {
    const extensionRoot = join(ROOT, "src/extension");
    const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
      });
    const callSites = sourceFiles(extensionRoot).flatMap((path) => {
      const lines = readFileSync(path, "utf-8").split("\n");
      return lines
        .filter((line) => !line.trimStart().startsWith("//") && /chrome\.permissions\.request\s*\(/.test(line))
        .map(() => path.slice(ROOT.length + 1));
    });

    expect(callSites).toEqual(["src/extension/welcome.ts"]);
  });

  it("asks for the active manifest's entire outstanding optional surface in onboarding", () => {
    const src = readFileSync(join(ROOT, "src/extension/welcome.ts"), "utf-8");
    expect(src).toContain("declaredOptionalPermissions()");
    expect(src).toContain("missingPermissions(declared)");
    expect(src).toContain("chrome.permissions.request(outstanding)");
  });

  it("keeps popup and background limited to checks and onboarding routing", () => {
    const popup = readFileSync(join(ROOT, "src/extension/popup.ts"), "utf-8");
    const popupHtml = readFileSync(join(ROOT, "src/extension/popup.html"), "utf-8");
    const popupCss = readFileSync(join(ROOT, "src/extension/popup.css"), "utf-8");
    const background = readFileSync(join(ROOT, "src/extension/background.ts"), "utf-8");
    expect(popup).toContain("declaredOptionalPermissions");
    expect(popup).not.toContain('"crawlio:pendingPermissions"');
    expect(popup).not.toMatch(/RESIDENT_OBSERVATION|ResidentPopupStatus|residentEnabled|residentClear/);
    expect(popupHtml).not.toMatch(/Local training|resident-card|resident-enabled|Clear retained data/);
    expect(popupCss).not.toMatch(/\.resident-(?:card|heading|title|desc|status|switch|clear)/);
    expect(background).toContain("declaredOptionalPermissions()");
    expect(background).toContain("declaredRequiredPermissions()");
    expect(background).toContain("required: REQUIRED_PERMISSIONS");
    expect(background).not.toContain("stagePermissionRequest");
    expect(background).not.toContain('"crawlio:pendingPermissions"');
    expect(background).not.toMatch(/GET_RESIDENT_OBSERVATION_STATUS|SET_RESIDENT_OBSERVATION_ENABLED|CLEAR_RESIDENT_OBSERVATION_DATA/);
  });

  it("keeps an extension-owned resident training tab out of the arbitrary-tab permission gate", () => {
    const src = readFileSync(join(ROOT, "src/extension/background.ts"), "utf-8");
    const functionStart = src.indexOf("async function startResidentTraining");
    const functionEnd = src.indexOf("const RESIDENT_STATIC_RESOURCE_TYPES", functionStart);
    const residentStart = src.slice(functionStart, functionEnd);
    const invocationStart = residentStart.indexOf("handleCommandWithRecording({");
    const invocationEnd = residentStart.indexOf("}) as", invocationStart);
    const recordingInvocation = residentStart.slice(invocationStart, invocationEnd);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(invocationStart).toBeGreaterThanOrEqual(0);
    expect(invocationEnd).toBeGreaterThan(invocationStart);
    expect(recordingInvocation).toContain('type: "start_recording"');
    // startNetworkCapture already made the just-created tab primary. Supplying tabId here would
    // route it through resolveTargetTab(), whose `tabs` grant is intentionally reserved for a
    // caller adopting an arbitrary existing tab.
    expect(recordingInvocation).not.toContain("tabId:");
  });
});
