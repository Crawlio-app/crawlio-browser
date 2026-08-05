// Read-only egress audit — `crawlio-browser audit-egress`.
//
// This command CHANGES NOTHING. That is deliberate and it is the whole design: a user cannot
// consent to — or defend against — what they cannot see, so the audit comes before any
// mitigation. Every host this process may contact is declared here as data, so the answer to
// "what does this thing phone home to?" is one command, not a code review.
//
// The declared table is cross-checked against the real extension manifest by
// `tests/unit/egress-audit.test.ts`, so a drift between what we CLAIM and what we SHIP fails CI
// rather than quietly becoming a lie.
import { readFileSync } from "node:fs";
import { getInstallId, installIdPath, telemetryEnabled, telemetryEndpoint } from "./telemetry.js";
import { PKG_VERSION } from "../shared/constants.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * How a destination is reached.
 *  - `unsolicited`     — we contact it without the user asking. The category that matters.
 *  - `user-initiated`  — only as the direct result of an explicit command/flag.
 *  - `target-directed` — the site the user asked us to visit.
 *  - `local`           — loopback only; never leaves the machine.
 */
export type EgressClass = "unsolicited" | "user-initiated" | "target-directed" | "local";

export interface EgressEntry {
  host: string;
  klass: EgressClass;
  purpose: string;
  /** What identifying information this destination observes — including what it sees implicitly. */
  carries: string;
  /** How to stop it. */
  control: string;
}

/** Every destination this process may contact. The single source of truth for E1. */
export const DECLARED_EGRESS: readonly EgressEntry[] = Object.freeze([
  {
    host: "worker.crawlio.app",
    klass: "unsolicited",
    purpose: "anonymous usage analytics — install ping, then an aggregate heartbeat every 30 min",
    carries:
      "install id, package/node version, platform, tool-call count, uptime. " +
      "The endpoint ALSO observes your source IP and the time of each ping — see the note below.",
    control: "CRAWLIO_TELEMETRY=0 (total), or `telemetry rotate` to break continuity",
  },
  {
    host: "api.cloudflare.com",
    klass: "user-initiated",
    purpose: "Cloudflare tunnel setup",
    carries: "your Cloudflare API token and account list",
    control: "only runs when you pass `--cloudflare` to init; omit it and this is never contacted",
  },
  {
    host: "127.0.0.1 (Crawlio.app control server)",
    klass: "local",
    purpose: "enrichment + crawled-URL queries against the local app",
    carries: "nothing leaves the machine",
    control: "n/a — loopback",
  },
  {
    host: "127.0.0.1 (extension WebSocket bridge)",
    klass: "local",
    purpose: "health check + command channel to the Chrome extension",
    carries: "nothing leaves the machine",
    control: "n/a — loopback",
  },
  {
    host: "<the sites you browse>",
    klass: "target-directed",
    purpose: "the pages you point the agent at, via the debugger-attached tab",
    carries: "whatever your own browser session carries",
    control: "you choose the targets",
  },
]);

/**
 * The extension's permission surface, declared here and verified against `manifest.prod.json` by
 * the unit test. Kept as data so the audit can state it without shipping a manifest read path.
 */
export const DECLARED_EXTENSION_SURFACE = Object.freeze({
  permissions: Object.freeze(["alarms", "debugger", "storage"]),
  host_permissions: Object.freeze([] as string[]),
  optional_host_permissions: Object.freeze(["http://127.0.0.1/*"]),
});

export interface EgressAuditReport {
  pkgVersion: string;
  installId: string;
  installIdFile: string;
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  telemetryEndpointOverridden: boolean;
  egress: readonly EgressEntry[];
  extension: typeof DECLARED_EXTENSION_SURFACE;
}

/** Gather the audit. Read-only: touches no network and mutates nothing but the id file's existence. */
export function collectEgressAudit(): EgressAuditReport {
  return {
    pkgVersion: PKG_VERSION,
    installId: getInstallId(),
    installIdFile: installIdPath(),
    telemetryEnabled: telemetryEnabled(),
    telemetryEndpoint: telemetryEndpoint(),
    telemetryEndpointOverridden: Boolean(process.env.CRAWLIO_TELEMETRY_URL),
    egress: DECLARED_EGRESS,
    extension: DECLARED_EXTENSION_SURFACE,
  };
}

const CLASS_LABEL: Record<EgressClass, (s: string) => string> = {
  unsolicited: yellow,
  "user-initiated": cyan,
  "target-directed": dim,
  local: green,
};

/** Render the audit as the text the command prints. Pure — takes a report, returns a string. */
export function renderEgressAudit(r: EgressAuditReport): string {
  const out: string[] = [];
  const rule = dim("─".repeat(74));

  out.push("");
  out.push(bold(`  Crawlio Browser — egress audit`) + dim(`  v${r.pkgVersion}`));
  out.push(dim("  Read-only. This command changes nothing."));
  out.push(rule);

  // ── Identity (E2) ──
  out.push(bold("  Identity"));
  out.push(`    install id      ${cyan(r.installId)}`);
  out.push(`    stored at       ${r.installIdFile}`);
  out.push(
    `    telemetry       ${r.telemetryEnabled ? yellow("ON") : green("OFF")}` +
      dim(r.telemetryEnabled ? "   (disable: CRAWLIO_TELEMETRY=0)" : "   (CRAWLIO_TELEMETRY is set to off)"),
  );
  out.push(
    `    endpoint        ${r.telemetryEndpoint}` +
      (r.telemetryEndpointOverridden ? dim("   (overridden by CRAWLIO_TELEMETRY_URL)") : ""),
  );
  out.push("");
  out.push(dim("    The install id is random, minted on this machine, and held by no account."));
  out.push(dim("    Deleting it or running `telemetry rotate` yields a genuinely NEW id — we cannot"));
  out.push(dim("    restore the old one. But the endpoint also sees your IP and the time of each"));
  out.push(dim("    ping, and id + IP + timestamps is correlatable at the receiving end. If that"));
  out.push(dim("    matters to you, turn it off rather than rotate it."));
  out.push(rule);

  // ── Egress (E1) ──
  out.push(bold("  Where this process can connect"));
  out.push("");
  for (const e of r.egress) {
    const tag = CLASS_LABEL[e.klass](`[${e.klass}]`);
    out.push(`    ${bold(e.host)}  ${tag}`);
    out.push(dim(`      purpose  ${e.purpose}`));
    out.push(dim(`      carries  ${e.carries}`));
    out.push(dim(`      control  ${e.control}`));
    out.push("");
  }
  const unsolicited = r.egress.filter((e) => e.klass === "unsolicited");
  out.push(
    unsolicited.length === 0
      ? green("    No unsolicited egress.")
      : yellow(`    ${unsolicited.length} unsolicited destination(s): `) +
          unsolicited.map((e) => e.host).join(", "),
  );
  out.push(rule);

  // ── Extension surface ──
  out.push(bold("  Chrome extension permission surface"));
  out.push(`    permissions            ${r.extension.permissions.join(", ")}`);
  out.push(
    `    host_permissions       ${
      r.extension.host_permissions.length ? r.extension.host_permissions.join(", ") : green("none")
    }`,
  );
  out.push(`    optional host access   ${r.extension.optional_host_permissions.join(", ") || "none"}`);
  out.push("");
  out.push(dim("    No <all_urls> and no standing host permissions: the extension cannot read a"));
  out.push(dim("    page until you attach the debugger to that tab."));
  out.push(rule);
  out.push(dim("  Telemetry detail: TELEMETRY.md"));
  out.push("");

  return out.join("\n");
}

/** Entry point for the `audit-egress` subcommand. `--json` emits the raw report. */
export function runEgressAudit(argv: readonly string[] = []): void {
  const report = collectEgressAudit();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderEgressAudit(report));
}

/** Entry point for the `telemetry rotate` subcommand. The only mutating command in this module. */
export function runTelemetryRotate(rotate: () => { previous: string | null; next: string }): void {
  const { previous, next } = rotate();
  console.log("");
  console.log(`  ${bold("Install id rotated.")}`);
  console.log(`    previous   ${previous ? dim(previous) : dim("(none — no id existed yet)")}`);
  console.log(`    new        ${cyan(next)}`);
  console.log("");
  console.log(dim("  The previous id is gone from this machine and was never held against an"));
  console.log(dim("  account, so it cannot be restored. Past pings already sent keep the old id;"));
  console.log(dim("  rotation breaks continuity going forward, it does not erase history."));
  console.log("");
}

/** Read a JSON file, or null. Used only by tests that cross-check the declared surface. */
export function readJsonFile<T = unknown>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
