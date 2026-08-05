export class BridgeRetryGate {
  private nextAllowedAt = 0;

  constructor(private readonly intervalMs: number) {}

  reserve(now = Date.now()): number {
    if (now >= this.nextAllowedAt) {
      this.nextAllowedAt = now + this.intervalMs;
      return 0;
    }
    return this.nextAllowedAt - now;
  }

  reset(): void {
    this.nextAllowedAt = 0;
  }
}

/**
 * Owns exactly one asynchronously-created connection.
 *
 * Concurrent callers share one factory invocation, established connections are reused,
 * and callbacks from an older generation cannot clear a replacement connection. Resetting
 * invalidates an in-flight candidate; if it arrives later it is disposed instead of adopted.
 */
export class SingletonConnection<T> {
  private value: T | null = null;
  private inFlight: Promise<T | null> | null = null;
  private generation = 0;

  constructor(
    private readonly dispose: (value: T) => void,
    private readonly onAdopt: (value: T) => void = () => {}
  ) {}

  get current(): T | null {
    return this.value;
  }

  connect(factory: () => Promise<T | null>): Promise<T | null> {
    if (this.value !== null) return Promise.resolve(this.value);
    if (this.inFlight !== null) return this.inFlight;

    const generation = this.generation;
    const flight: Promise<T | null> = factory()
      .then((candidate) => {
        if (candidate === null) return null;
        if (this.generation !== generation || this.value !== null) {
          this.dispose(candidate);
          return this.value;
        }
        this.value = candidate;
        try {
          this.onAdopt(candidate);
        } catch {
          this.value = null;
          this.dispose(candidate);
          return null;
        }
        return candidate;
      })
      .catch(() => null)
      .finally(() => {
        if (this.inFlight === flight) this.inFlight = null;
      });
    this.inFlight = flight;
    return flight;
  }

  clearIfCurrent(candidate: T): boolean {
    if (this.value !== candidate) return false;
    this.value = null;
    return true;
  }

  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    const current = this.value;
    this.value = null;
    if (current !== null) this.dispose(current);
  }
}

export function safeWebSocketSend(socket: WebSocket, payload: string): boolean {
  if (socket.readyState !== 1) return false;
  try {
    socket.send(payload);
    return true;
  } catch {
    return false;
  }
}

export function closeFailedHandshake(socket: WebSocket, reason: string): void {
  try {
    socket.close(1011, reason.slice(0, 123));
  } catch {
    // Already closed or context invalidated.
  }
}

// A single live bridge's liveness probe. `lastActivityAt` is the server's
// /health `lastActivityAt` (epoch ms) — defaults to 0 until the server ships it.
export interface BridgeProbe {
  port: number;
  lastActivityAt: number;
}

// Pick THE one bridge the extension should be attached to from the set of live
// probes. "The active bridge" is the one with the most recent activity, so the
// extension follows whichever MCP session is actually being driven.
//
// Tie-break (equal lastActivityAt — including the all-zero pre-rollout case):
//   - prefer currentActivePort if it's among the tied set (sticky → anti-flap)
//   - else the lowest port (deterministic → converges on primary 9333)
export function electActiveBridge(
  probes: BridgeProbe[],
  currentActivePort: number | null
): number | null {
  if (probes.length === 0) return null;
  let max = -Infinity;
  for (const p of probes) {
    if (p.lastActivityAt > max) max = p.lastActivityAt;
  }
  const tied = probes.filter(p => p.lastActivityAt === max);
  if (tied.length === 1) return tied[0]!.port;
  // Sticky: if the current active port is still in the tied set, keep it.
  if (currentActivePort !== null && tied.some(p => p.port === currentActivePort)) {
    return currentActivePort;
  }
  // Deterministic fallback: lowest port.
  return tied.reduce((lo, p) => (p.port < lo ? p.port : lo), tied[0]!.port);
}

export interface ConnectionPlanState {
  // Have we been handed the real bridge token over the authenticated native channel?
  hasToken: boolean;
  // The port we currently route to (or null), and whether its socket is OPEN + has
  // passed the identity handshake under the trusted token.
  activePort: number | null;
  activeIsOpen: boolean;
  activeVerified: boolean;
}

/**
 * Decide which live bridges the extension should OPEN a socket to. Routing stays single
 * (the caller only ever sends to the active port), so opening more than one socket here
 * never re-creates the reply storm — it only lets the identity handshake find the real
 * server. The rules keep a rogue server from displacing a verified one:
 *
 *   - No token (TOFU): single-bridge election by most-recent activity (unchanged storm fix).
 *     → [electedPort] or [].
 *   - Token held + a VERIFIED bridge is already active: connect to NOTHING. A rogue that
 *     forges a higher /health lastActivityAt must not be able to displace (DoS) the verified
 *     incumbent — activity is an attacker-controlled signal, so it cannot outrank a proof.
 *   - Token held + NO verified bridge yet (cold start): connect to ALL live candidates and
 *     let the handshake promote the real one. A single-port election would otherwise keep
 *     electing the forged-max-activity rogue and starve the real bridge forever.
 *
 * `live` is deduped/sorted by the caller's probe order; output preserves input order.
 */
export function planBridgeConnections(live: BridgeProbe[], s: ConnectionPlanState): number[] {
  if (!s.hasToken) {
    const elected = electActiveBridge(live, s.activePort);
    return elected === null ? [] : [elected];
  }
  if (s.activePort !== null && s.activeIsOpen && s.activeVerified) return [];
  return live.map(p => p.port);
}
