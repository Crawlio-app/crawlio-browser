// The selector-agent I/O contract.
//
// Mirrors Selector Forge's `lib/state/schema.ts` (MIT, © The Metrics Shop,
// Inc.) so a Crawlio-native proposer and the browser/headless engines round-
// trip the same envelope as the upstream cloud. Zod-validated plain data —
// every value is JSON-serializable.

import { z } from "zod";

export const selectorTypeSchema = z.enum(["css", "xpath"]);
export type SelectorType = z.infer<typeof selectorTypeSchema>;

export const selectorSchema = z.object({
  type: selectorTypeSchema,
  value: z.string().min(1),
});
export type SelectorRecord = z.infer<typeof selectorSchema>;

export const selectorModeSchema = z.enum(["single", "list"]);
export type SelectorMode = z.infer<typeof selectorModeSchema>;

// Where a candidate came from: a deterministic client seed, or the agent.
export const candidateSourceSchema = z.enum(["extension_seed", "agent"]);
export type CandidateSource = z.infer<typeof candidateSourceSchema>;

export const candidateSchema = z.object({
  selector: selectorSchema,
  strategy: z.string(),
  matchCount: z.number().int().nonnegative(),
  exact: z.boolean(),
  source: candidateSourceSchema,
});
export type CandidateRecord = z.infer<typeof candidateSchema>;

// A target element the user picked.
export const targetSchema = z.object({
  elementId: z.string(),
  elementXpath: z.string().optional(),
});
export type TargetRecord = z.infer<typeof targetSchema>;

// Browser actions the agent asks the engine to perform. v1: only test_selectors.
export const browserRequestTypeSchema = z.enum(["test_selectors"]);
export type BrowserRequestType = z.infer<typeof browserRequestTypeSchema>;

export const browserRequestSchema = z.object({
  id: z.string(),
  type: browserRequestTypeSchema,
  selectors: z.array(selectorSchema).min(1),
  needHtmlForFeedback: z.boolean().optional(),
});
export type BrowserRequestRecord = z.infer<typeof browserRequestSchema>;

export const selectorResultSchema = z.object({
  selector: selectorSchema,
  foundElementIds: z.array(z.string()),
});
export type SelectorResultRecord = z.infer<typeof selectorResultSchema>;

export const browserResultSchema = z.object({
  requestId: z.string(),
  selectorResults: z.array(selectorResultSchema),
  elementHtmlById: z.record(z.string(), z.string()).optional(),
});
export type BrowserResultRecord = z.infer<typeof browserResultSchema>;

export const finalResultSchema = z.object({
  status: z.enum(["ok", "fallback", "error"]),
  bestSelector: selectorSchema.optional(),
  note: z.string().optional(),
});
export type FinalSelectorResult = z.infer<typeof finalResultSchema>;

// The single round-trip envelope between engine and proposer.
export const selectorCreateStateSchema = z.object({
  sessionId: z.string().min(1),
  mode: selectorModeSchema,
  targets: z.array(targetSchema).min(1),
  inspectionView: z.string(),
  seedCandidates: z.array(candidateSchema),
  browserRequest: browserRequestSchema.nullable(),
  browserResult: browserResultSchema.nullable(),
  finalResult: finalResultSchema.optional(),
});
export type SelectorCreateState = z.infer<typeof selectorCreateStateSchema>;

// What the proposer tells the engine to do next.
export const nextActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("test_selectors"), requestId: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error") }),
]);
export type NextAction = z.infer<typeof nextActionSchema>;

export const selectorCreateResponseSchema = z.object({
  state: selectorCreateStateSchema,
  action: nextActionSchema,
});
export type SelectorCreateResponse = z.infer<
  typeof selectorCreateResponseSchema
>;
