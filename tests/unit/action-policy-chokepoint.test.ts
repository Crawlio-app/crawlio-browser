import { describe, expect, it } from "vitest";
import { makePolicyEnforcingBridge } from "../../src/mcp-server/tools.js";
import type { WebSocketBridge } from "../../src/mcp-server/websocket-bridge.js";
import type { ActionPolicy } from "../../src/mcp-server/action-policy.js";

/**
 * The in-execute action policy was once enforced only on the sandbox's direct
 * `bridge` channel. The `smart.*` / ocrScreenshot helpers close over the real
 * bridge and reached `bridge.send` with no policy check, so a `{ deny:["browser_*"] }`
 * policy was bypassed. makePolicyEnforcingBridge is the single chokepoint every
 * browser op now flows through.
 */
type Cmd = Parameters<WebSocketBridge["send"]>[0];
const cmd = (type: string, extra: Record<string, unknown> = {}): Cmd => ({ type, ...extra }) as unknown as Cmd;

function fakeBridge(): { sent: unknown[]; bridge: WebSocketBridge } {
  const sent: unknown[] = [];
  const bridge = {
    send: (command: unknown) => {
      sent.push(command);
      return Promise.resolve({ ok: true });
    },
    isConnected: () => true,
  } as unknown as WebSocketBridge;
  return { sent, bridge };
}

describe("makePolicyEnforcingBridge", () => {
  it("denies a browser_* command the policy denies — the path smart.click/evaluate took", async () => {
    const { sent, bridge } = fakeBridge();
    const policy: ActionPolicy = { default: "allow", deny: ["browser_*"] };
    const guarded = makePolicyEnforcingBridge(bridge, () => policy);
    await expect(guarded.send(cmd("browser_evaluate", { expression: "document.cookie" }))).rejects.toThrow(/denied/i);
    expect(sent).toHaveLength(0); // never reached the real bridge
  });

  it("allows a non-denied command through to the real bridge", async () => {
    const { sent, bridge } = fakeBridge();
    const policy: ActionPolicy = { default: "allow", deny: ["browser_*"] };
    const guarded = makePolicyEnforcingBridge(bridge, () => policy);
    await guarded.send(cmd("list_tabs"));
    expect(sent).toHaveLength(1);
  });

  it("reads the policy LIVE so a cached wrapper enforces a later-changed policy", async () => {
    const { sent, bridge } = fakeBridge();
    let policy: ActionPolicy | null = null;
    const guarded = makePolicyEnforcingBridge(bridge, () => policy);
    await guarded.send(cmd("browser_click", { selector: "#x" })); // no policy yet -> allowed
    expect(sent).toHaveLength(1);
    policy = { default: "allow", deny: ["browser_*"] };
    await expect(guarded.send(cmd("browser_click", { selector: "#x" }))).rejects.toThrow(/denied/i);
    expect(sent).toHaveLength(1); // second call blocked at the chokepoint
  });

  it("honors an allowlist with default deny (only allowed types pass)", async () => {
    const { sent, bridge } = fakeBridge();
    const policy: ActionPolicy = { default: "deny", allow: ["get_*", "list_tabs"] };
    const guarded = makePolicyEnforcingBridge(bridge, () => policy);
    await guarded.send(cmd("list_tabs"));
    await expect(guarded.send(cmd("browser_navigate", { url: "https://x" }))).rejects.toThrow(/denied/i);
    expect(sent).toHaveLength(1);
  });

  it("exposes ONLY a policy-checked send — no passthrough to the raw bridge (unbypassable by construction)", () => {
    const { bridge } = fakeBridge();
    const guarded = makePolicyEnforcingBridge(bridge, () => null);
    // The narrow sender deliberately does NOT forward other bridge methods, so tool
    // code can never reach the underlying WebSocketBridge to get an un-checked send.
    expect((guarded as unknown as { isConnected?: unknown }).isConnected).toBeUndefined();
    expect(typeof (guarded as unknown as { send: unknown }).send).toBe("function");
  });
});
