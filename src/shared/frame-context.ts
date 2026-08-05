export interface EvalParamOpts {
  returnByValue?: boolean;
  awaitPromise?: boolean;
  useFrameContext?: boolean;
}

/**
 * Build Runtime.evaluate params with optional frame context injection.
 * Pure function — all state passed as parameters for testability.
 *
 * Defaults: returnByValue=true, awaitPromise=false, useFrameContext=true.
 * When useFrameContext is true (default) and activeFrameId is set,
 * contextId is injected so the eval runs in the correct iframe.
 */
export function buildEvalParams(
  expression: string,
  activeFrameId: string | null,
  contextId: number | undefined,
  opts?: EvalParamOpts
): Record<string, unknown> {
  const params: Record<string, unknown> = { expression };
  if (opts?.returnByValue !== false) params.returnByValue = true;
  if (opts?.awaitPromise) params.awaitPromise = true;
  if (opts?.useFrameContext !== false && activeFrameId) {
    if (contextId !== undefined) params.contextId = contextId;
  }
  return params;
}
