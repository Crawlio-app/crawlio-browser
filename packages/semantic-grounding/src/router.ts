import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GroundingContext,
  GroundingOperation,
  GroundingResult,
  ProviderKind,
  RerankCandidate,
  SemanticGroundingProvider,
} from "./types.js";
import { PROVIDER_PRECEDENCE } from "./types.js";
import { assertGroundingResult } from "./validator.js";
import { createHeuristicProvider } from "./providers/heuristic.js";
import { createOnnxProvider, type OnnxProviderOptions } from "./providers/onnx.js";

function operationCapability(operation: GroundingOperation): "embed" | "classify" | "rerank" | "ground" {
  return operation;
}

function precedence(kind: ProviderKind): number {
  const index = PROVIDER_PRECEDENCE.indexOf(kind);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function annotateResult(provider: SemanticGroundingProvider, result: GroundingResult, routedBecause: string): GroundingResult {
  const next: GroundingResult = {
    ...result,
    provider: result.provider || provider.id,
    kind: result.kind || provider.kind,
    modelVersion: result.modelVersion || provider.modelVersion,
    adapterId: result.adapterId ?? provider.adapterId,
    evidenceRefs: Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [],
    routedBecause: result.routedBecause || routedBecause,
  };
  assertGroundingResult(next);
  return next;
}

export interface RouterOptions {
  providers: SemanticGroundingProvider[];
}

export class SemanticGroundingRouter {
  private readonly providers: SemanticGroundingProvider[];

  constructor(options: RouterOptions) {
    this.providers = [...options.providers].sort((a, b) => precedence(a.kind) - precedence(b.kind));
  }

  async select(operation: GroundingOperation): Promise<{ provider: SemanticGroundingProvider; routedBecause: string }> {
    const capability = operationCapability(operation);
    for (const provider of this.providers) {
      if (!provider.capabilities.includes(capability)) continue;
      const handler = provider[operation];
      if (typeof handler !== "function") continue;
      const available = provider.isAvailable ? await provider.isAvailable() : true;
      if (!available) continue;
      return {
        provider,
        routedBecause: `${provider.kind} provider available for ${operation}; precedence=ane->onnx->heuristic`,
      };
    }
    throw new Error(`No available semantic grounding provider for ${operation}`);
  }

  private async run(
    operation: "embed",
    execute: (provider: SemanticGroundingProvider, routedBecause: string) => Promise<GroundingResult>,
  ): Promise<GroundingResult>;
  private async run(
    operation: "classify",
    execute: (provider: SemanticGroundingProvider, routedBecause: string) => Promise<GroundingResult>,
  ): Promise<GroundingResult>;
  private async run(
    operation: "rerank",
    execute: (provider: SemanticGroundingProvider, routedBecause: string) => Promise<GroundingResult>,
  ): Promise<GroundingResult>;
  private async run(
    operation: "ground",
    execute: (provider: SemanticGroundingProvider, routedBecause: string) => Promise<GroundingResult>,
  ): Promise<GroundingResult>;
  private async run(
    operation: GroundingOperation,
    execute: (provider: SemanticGroundingProvider, routedBecause: string) => Promise<GroundingResult>,
  ): Promise<GroundingResult> {
    const capability = operationCapability(operation);
    const failures: string[] = [];
    for (const provider of this.providers) {
      if (!provider.capabilities.includes(capability)) continue;
      const handler = provider[operation];
      if (typeof handler !== "function") continue;
      const available = provider.isAvailable ? await provider.isAvailable() : true;
      if (!available) continue;
      const routedBecause = `${provider.kind} provider available for ${operation}; precedence=ane->onnx->heuristic`;
      try {
        return await execute(provider, routedBecause);
      } catch (error) {
        failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No semantic grounding provider completed ${operation}${failures.length ? ` (${failures.join("; ")})` : ""}`);
  }

  async embed(texts: string[]): Promise<GroundingResult> {
    return this.run("embed", async (provider, routedBecause) => {
      const result = await provider.embed!(texts);
      return annotateResult(provider, result, routedBecause);
    });
  }

  async classify(input: string, labels: string[]): Promise<GroundingResult> {
    return this.run("classify", async (provider, routedBecause) => {
      const result = await provider.classify!(input, labels);
      return annotateResult(provider, result, routedBecause);
    });
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<GroundingResult> {
    return this.run("rerank", async (provider, routedBecause) => {
      const result = await provider.rerank!(query, candidates);
      return annotateResult(provider, result, routedBecause);
    });
  }

  async ground(query: string, context: GroundingContext): Promise<GroundingResult> {
    return this.run("ground", async (provider, routedBecause) => {
      const result = await provider.ground!(query, context);
      return annotateResult(provider, result, routedBecause);
    });
  }
}

export interface AneSocketProviderOptions {
  socketPath?: string;
}

export function createAneSocketProvider(options: AneSocketProviderOptions = {}): SemanticGroundingProvider {
  const socketPath = options.socketPath ?? join(homedir(), ".mentu", "ane-control.sock");
  const unavailable = async (): Promise<never> => {
    throw new Error(`ANE provider is unavailable; no daemon handshake at ${socketPath}`);
  };
  return {
    id: "mentu-ane",
    kind: "ane",
    modelVersion: "ane-socket-client-1.0.0",
    capabilities: ["embed", "classify", "rerank", "ground"],
    isAvailable: async () => process.platform === "darwin" && process.env.CRAWLIO_SEMANTIC_ANE_STUB === "1" && Boolean(await access(socketPath).then(() => true).catch(() => false)),
    embed: unavailable,
    classify: unavailable,
    rerank: unavailable,
    ground: unavailable,
  };
}

export interface DefaultRouterOptions {
  onnx?: OnnxProviderOptions;
  includeAne?: boolean;
}

export function createDefaultRouter(options: DefaultRouterOptions = {}): SemanticGroundingRouter {
  return new SemanticGroundingRouter({
    providers: [
      ...(options.includeAne === false ? [] : [createAneSocketProvider()]),
      createOnnxProvider(options.onnx),
      createHeuristicProvider(),
    ],
  });
}
