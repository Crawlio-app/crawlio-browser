// --- CDP Domain Enable Result ---
export interface DomainStatus {
  domain: string;
  success: boolean;
  error?: string;
}

export interface DomainEnableResult {
  required: DomainStatus[];
  optional: DomainStatus[];
  allRequiredOk: boolean;
}

// Params required when replaying a stored domain-enable command during CDP
// disconnect recovery. `DomainStatus.domain` holds the full CDP method name
// ("Page.enable", "Page.setInterceptFileChooserDialog"), so replay sends it
// verbatim — with these params where the method needs them.
export const DOMAIN_ENABLE_PARAMS: Record<string, Record<string, unknown>> = {
  "Performance.enable": { timeDomain: "timeTicks" },
  "Page.setInterceptFileChooserDialog": { enabled: true },
};

/**
 * Merge a new domain-enable record into a tab's existing one instead of
 * overwriting it. `ensureDebugger` and `startNetworkCapture` can both record
 * domain state for the same tab; a plain last-writer-wins overwrite lets the
 * poorer record (Page/Runtime only) strip the richer capture record, so the
 * disconnect-recovery path would silently re-enable too few domains.
 *
 * Per-domain, the newest status wins; domains only ever accumulate within an
 * attached session (they reset when the tab's state is deleted on detach).
 */
export function mergeDomainState(
  existing: DomainEnableResult | undefined,
  incoming: DomainEnableResult
): DomainEnableResult {
  if (!existing) return incoming;
  const merge = (base: DomainStatus[], next: DomainStatus[]): DomainStatus[] => {
    const byDomain = new Map(base.map((d) => [d.domain, d]));
    for (const d of next) byDomain.set(d.domain, d);
    return [...byDomain.values()];
  };
  return {
    required: merge(existing.required, incoming.required),
    optional: merge(existing.optional, incoming.optional),
    allRequiredOk: existing.allRequiredOk && incoming.allRequiredOk,
  };
}
