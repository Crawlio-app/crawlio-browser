import type { WebSocketBridge } from "./websocket-bridge.js";

// A module-private brand. Because it is never exported, no other module can build an
// object that satisfies PolicyEnforcedSender via a literal — only `makePolicyEnforcingBridge`
// mints one (through an explicit cast). A raw WebSocketBridge therefore is NOT assignable
// to a PolicyEnforcedSender slot, so a future helper cannot accidentally capture an
// un-policy-checked `send` from an outer closure (the policy-bypass drift) — it becomes a compile
// error instead of a silent bypass.
declare const POLICY_ENFORCED: unique symbol;

/**
 * The ONLY bridge surface that crawlio-agent tool code (execute, smart.*, ocrScreenshot)
 * may hold. Its `send()` is always action-policy-checked at one chokepoint. Tool builders
 * accept ONLY this type, never `WebSocketBridge`, so the chokepoint is unbypassable by
 * construction rather than by discipline.
 */
export interface PolicyEnforcedSender {
  readonly [POLICY_ENFORCED]: true;
  send(command: Parameters<WebSocketBridge["send"]>[0], timeout?: number): Promise<unknown>;
}

// Structural guard (the whole point of the brand): a raw WebSocketBridge must NOT be
// assignable to PolicyEnforcedSender. If a future refactor drops the brand, the raw
// bridge becomes structurally assignable, `RawBridgeIsBlocked` flips to `false`, and
// this line fails `npm run typecheck` — surfacing the policy-bypass drift before it can ship.
type RawBridgeIsBlocked = WebSocketBridge extends PolicyEnforcedSender ? false : true;
const _rawBridgeIsBlocked: RawBridgeIsBlocked = true;
void _rawBridgeIsBlocked;
