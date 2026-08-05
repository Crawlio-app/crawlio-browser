// Pure tracking event validator — no side effects, no bridge dependency
// Validates TrackingParseResult against per-vendor event schemas
// Checks: missing required/recommended params, invalid types, duplicates, no PageView, typo detection

import type {
  TrackingVendor,
  TrackingPixelEvent,
  TrackingParseResult,
  TrackingValidationIssue,
  TrackingValidationResult,
  ValidationSeverity,
} from "../shared/evidence-types.js";
import {
  VENDOR_SCHEMAS,
  isValidCurrency,
  isNumericParam,
  type EventSchema,
} from "./tracking-schemas.js";

function issue(
  event: TrackingPixelEvent,
  severity: ValidationSeverity,
  code: string,
  message: string,
  recommendation: string,
  parameter?: string,
): TrackingValidationIssue {
  return {
    vendor: event.vendor,
    pixelId: event.pixelId,
    eventName: event.eventName,
    severity,
    code,
    message,
    recommendation,
    parameter,
  };
}

function checkMissingRequired(event: TrackingPixelEvent, schema: EventSchema): TrackingValidationIssue[] {
  const issues: TrackingValidationIssue[] = [];
  for (const param of schema.requiredParams) {
    // Check both top-level params and cd.* (Facebook custom data) namespace
    const value = event.parameters[param] ?? event.parameters[`cd.${param}`];
    if (value === undefined || value === '') {
      issues.push(issue(
        event,
        'error',
        'MISSING_REQUIRED_PARAM',
        `${event.eventName} event is missing required parameter "${param}"`,
        `Add the "${param}" parameter to your ${event.vendor === 'facebook' ? 'fbq' : event.vendor} ${event.eventName} event call.`,
        param,
      ));
    }
  }
  return issues;
}

function checkMissingRecommended(event: TrackingPixelEvent, schema: EventSchema): TrackingValidationIssue[] {
  const issues: TrackingValidationIssue[] = [];
  for (const param of schema.recommendedParams) {
    const value = event.parameters[param] ?? event.parameters[`cd.${param}`];
    if (value === undefined || value === '') {
      issues.push(issue(
        event,
        'warning',
        'MISSING_RECOMMENDED_PARAM',
        `${event.eventName} event is missing recommended parameter "${param}"`,
        `Consider adding "${param}" to improve ${event.vendor === 'facebook' ? 'Meta Ads' : 'Google Analytics'} reporting and optimization.`,
        param,
      ));
    }
  }
  return issues;
}

function checkParamTypes(event: TrackingPixelEvent, schema: EventSchema): TrackingValidationIssue[] {
  if (!schema.paramTypes) return [];
  const issues: TrackingValidationIssue[] = [];
  for (const [param, expectedType] of Object.entries(schema.paramTypes)) {
    const value = event.parameters[param] ?? event.parameters[`cd.${param}`];
    if (value === undefined || value === '') continue;

    if (expectedType === 'number' && !isNumericParam(value)) {
      issues.push(issue(
        event,
        'warning',
        'INVALID_PARAM_TYPE',
        `${event.eventName} parameter "${param}" should be a number but got "${value.length > 20 ? value.substring(0, 20) + '...' : value}"`,
        `Ensure "${param}" is a numeric value (e.g., 29.99), not a formatted string.`,
        param,
      ));
    }
    if (expectedType === 'currency' && !isValidCurrency(value)) {
      issues.push(issue(
        event,
        'warning',
        'INVALID_CURRENCY',
        `${event.eventName} parameter "${param}" has invalid currency code "${value.length > 10 ? value.substring(0, 10) + '...' : value}"`,
        `Use a valid ISO 4217 currency code (e.g., "USD", "EUR", "GBP").`,
        param,
      ));
    }
  }
  return issues;
}

function vendorCallSyntax(vendor: TrackingVendor): string {
  switch (vendor) {
    case 'facebook': return 'fbq()';
    case 'ga4': return 'gtag()';
    case 'tiktok': return 'ttq.track()';
    case 'linkedin': return 'lintrk()';
    case 'pinterest': return 'pintrk()';
    default: return 'tracking';
  }
}

function checkDuplicateEvents(events: TrackingPixelEvent[]): TrackingValidationIssue[] {
  const issues: TrackingValidationIssue[] = [];
  // Count all occurrences first for accurate reporting
  const counts = new Map<string, { count: number; event: TrackingPixelEvent }>();
  for (const event of events) {
    const key = `${event.vendor}:${event.pixelId}:${event.eventName}:${event.url}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { count: 1, event });
    }
  }
  for (const [, { count, event }] of counts) {
    if (count >= 2) {
      issues.push(issue(
        event,
        'warning',
        'DUPLICATE_EVENT',
        `${event.eventName} event fired ${count} times for pixel ${event.pixelId} on the same URL`,
        `Check for duplicate ${vendorCallSyntax(event.vendor)} calls. Multiple fires of the same event can inflate metrics.`,
      ));
    }
  }
  return issues;
}

function checkNoPageView(events: TrackingPixelEvent[]): TrackingValidationIssue[] {
  const issues: TrackingValidationIssue[] = [];

  // Group by vendor+pixelId
  const groups = new Map<string, TrackingPixelEvent[]>();
  for (const event of events) {
    const key = `${event.vendor}:${event.pixelId}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }

  for (const [, group] of groups) {
    const vendor = group[0].vendor;
    const pixelId = group[0].pixelId;

    // Determine what the "page view" event name is for this vendor
    let pageViewName: string | null = null;
    if (vendor === 'facebook') pageViewName = 'PageView';
    else if (vendor === 'ga4') pageViewName = 'page_view';
    else if (vendor === 'pinterest') pageViewName = 'pagevisit';
    else if (vendor === 'linkedin') pageViewName = 'pageview';
    else continue; // TikTok doesn't have a PageView equivalent in standard events

    const hasPageView = group.some(e => e.eventName === pageViewName);
    const hasStandardEvents = group.some(e => e.eventType === 'standard' && e.eventName !== pageViewName);

    if (!hasPageView && hasStandardEvents) {
      issues.push(issue(
        group[0],
        'warning',
        'NO_PAGEVIEW',
        `Pixel ${pixelId} (${vendor}) fired standard events without a ${pageViewName} event`,
        `Ensure ${pageViewName} fires before other events. It initializes the pixel and is required for proper attribution.`,
      ));
    }
  }
  return issues;
}

// Levenshtein distance for typo detection
function levenshtein(a: string, b: string): number {
  if (a.length > 256 || b.length > 256) return Math.abs(a.length - b.length);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function checkUnknownCustomEvents(events: TrackingPixelEvent[]): TrackingValidationIssue[] {
  const issues: TrackingValidationIssue[] = [];
  const alreadyFlagged = new Set<string>();

  for (const event of events) {
    if (event.eventType !== 'custom') continue;

    const schemas = VENDOR_SCHEMAS[event.vendor];
    if (!schemas) continue;

    const key = `${event.vendor}:${event.eventName}`;
    if (alreadyFlagged.has(key)) continue;

    const standardNames = Object.keys(schemas);
    for (const standard of standardNames) {
      const dist = levenshtein(event.eventName.toLowerCase(), standard.toLowerCase());
      // Flag if edit distance is 1-2 (likely typo, not just a random custom event)
      if (dist > 0 && dist <= 2) {
        alreadyFlagged.add(key);
        issues.push(issue(
          event,
          'info',
          'POSSIBLE_TYPO',
          `Custom event "${event.eventName}" is similar to standard event "${standard}" — possible typo`,
          `If you intended to fire the standard "${standard}" event, fix the event name. Custom events don't benefit from standard event reporting features.`,
        ));
        break;
      }
    }
  }
  return issues;
}

export function validateTrackingEvents(parseResult: TrackingParseResult): TrackingValidationResult {
  const allIssues: TrackingValidationIssue[] = [];

  // Per-event schema checks
  for (const event of parseResult.events) {
    const schemas = VENDOR_SCHEMAS[event.vendor];
    if (!schemas) continue;

    const schema = schemas[event.eventName];
    if (!schema) continue;

    allIssues.push(...checkMissingRequired(event, schema));
    allIssues.push(...checkMissingRecommended(event, schema));
    allIssues.push(...checkParamTypes(event, schema));
  }

  // Cross-event checks
  allIssues.push(...checkDuplicateEvents(parseResult.events));
  allIssues.push(...checkNoPageView(parseResult.events));
  allIssues.push(...checkUnknownCustomEvents(parseResult.events));

  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const infoCount = allIssues.filter(i => i.severity === 'info').length;

  return {
    events: parseResult.events,
    issues: allIssues,
    errorCount,
    warningCount,
    infoCount,
    isHealthy: errorCount === 0,
  };
}
