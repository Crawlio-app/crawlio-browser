import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceEnvelope, EvidenceMetadata, ProvenanceSource, ConfidenceLevel } from "./schema.js";
import { detectNullGaps, deriveQuality } from "./wrap.js";

const EVIDENCE_DIR = ".crawlio/evidence";

const VALID_PROVENANCE_SOURCES: readonly ProvenanceSource[] = ["browser", "crawl", "network", "inferred", "user"] as const;
const VALID_GAP_IMPACTS = ["data-absent", "data-stale", "method-failed", "timeout"] as const;
const VALID_QUALITY = ["complete", "partial", "degraded", "unavailable"] as const;
const VALID_CONFIDENCE: readonly ConfidenceLevel[] = ["high", "medium", "low", "speculative"] as const;

function resolveEvidenceDir(baseDir: string, runId?: string): string {
  if (runId) {
    return join(baseDir, EVIDENCE_DIR, "runs", runId);
  }
  return join(baseDir, EVIDENCE_DIR);
}

export async function writeEvidence<T>(
  envelope: EvidenceEnvelope<T>,
  baseDir: string = process.cwd()
): Promise<string> {
  const runId = envelope.metadata?.runId;
  const dir = resolveEvidenceDir(baseDir, runId);
  await mkdir(dir, { recursive: true });

  // Validate enum values
  if (!VALID_PROVENANCE_SOURCES.includes(envelope.provenance?.source as ProvenanceSource)) {
    throw new Error(`Invalid provenance.source: "${envelope.provenance?.source}". Valid: ${VALID_PROVENANCE_SOURCES.join(", ")}`);
  }
  if (!(VALID_QUALITY as readonly string[]).includes(envelope.quality)) {
    throw new Error(`Invalid quality: "${envelope.quality}". Valid: ${VALID_QUALITY.join(", ")}`);
  }
  if (!VALID_CONFIDENCE.includes(envelope.confidence?.level as ConfidenceLevel)) {
    throw new Error(`Invalid confidence.level: "${envelope.confidence?.level}". Valid: ${VALID_CONFIDENCE.join(", ")}`);
  }
  for (const gap of envelope.gaps || []) {
    if (!(VALID_GAP_IMPACTS as readonly string[]).includes(gap.impact)) {
      throw new Error(`Invalid gap.impact: "${gap.impact}" on dimension "${gap.dimension}". Valid: ${VALID_GAP_IMPACTS.join(", ")}`);
    }
  }

  const nullGaps = detectNullGaps(envelope.payload);
  const existingDimensions = new Set(envelope.gaps.map(g => g.dimension));
  const missingGaps = nullGaps.filter(g => !existingDimensions.has(g.dimension));
  const augmentedGaps = missingGaps.length > 0
    ? [...envelope.gaps, ...missingGaps]
    : envelope.gaps;

  // Stamp metadata.validatedBy to prove this went through writeEvidence
  const metadata: EvidenceMetadata = {
    writtenVia: envelope.metadata?.writtenVia ?? "wrapEvidence",
    validatedBy: "writeEvidence",
    version: "1.0",
    ...(runId ? { runId } : {}),
  };

  const augmented = {
    ...envelope,
    gaps: augmentedGaps,
    quality: deriveQuality(augmentedGaps, envelope.confidence),
    metadata,
  };

  const filePath = join(dir, `${augmented.evidenceId}.json`);
  await writeFile(filePath, JSON.stringify(augmented, null, 2), "utf-8");
  return filePath;
}

const ENVELOPE_REQUIRED_FIELDS = ["evidenceId", "type", "url", "provenance", "confidence", "gaps", "quality", "payload", "createdAt"] as const;

export async function readEvidence<T>(
  evidenceId: string,
  baseDir: string = process.cwd(),
  runId?: string
): Promise<EvidenceEnvelope<T>> {
  const dir = resolveEvidenceDir(baseDir, runId);
  const filePath = join(dir, `${evidenceId}.json`);
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  for (const field of ENVELOPE_REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      throw new Error(`Invalid evidence envelope ${evidenceId}: missing required field "${field}"`);
    }
  }
  if (!Array.isArray(parsed.gaps)) {
    throw new Error(`Invalid evidence envelope ${evidenceId}: "gaps" must be an array`);
  }
  return parsed as EvidenceEnvelope<T>;
}

export async function listEvidence(
  baseDir: string = process.cwd(),
  runId?: string
): Promise<string[]> {
  const dir = resolveEvidenceDir(baseDir, runId);
  try {
    const files = await readdir(dir);
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
  } catch {
    return [];
  }
}

export async function listRuns(
  baseDir: string = process.cwd()
): Promise<string[]> {
  const runsDir = join(baseDir, EVIDENCE_DIR, "runs");
  try {
    const dirs = await readdir(runsDir);
    return dirs;
  } catch {
    return [];
  }
}

export interface AuditResult {
  evidenceId: string;
  valid: boolean;
  errors: string[];
}

export async function auditEvidence(
  baseDir: string = process.cwd(),
  runId?: string
): Promise<AuditResult[]> {
  const ids = await listEvidence(baseDir, runId);
  const results: AuditResult[] = [];

  for (const id of ids) {
    const errors: string[] = [];
    try {
      const envelope = await readEvidence(id, baseDir, runId);

      // Check metadata stamp (bypass detection)
      if (!envelope.metadata?.writtenVia) {
        errors.push("missing metadata.writtenVia — evidence may not have been created via wrapEvidence()");
      }
      if (!envelope.metadata?.validatedBy) {
        errors.push("missing metadata.validatedBy — evidence may not have been persisted via writeEvidence()");
      }

      // Validate enums
      if (!VALID_PROVENANCE_SOURCES.includes(envelope.provenance?.source as ProvenanceSource)) {
        errors.push(`invalid provenance.source: "${envelope.provenance?.source}"`);
      }
      if (!(VALID_QUALITY as readonly string[]).includes(envelope.quality)) {
        errors.push(`invalid quality: "${envelope.quality}"`);
      }
      if (!VALID_CONFIDENCE.includes(envelope.confidence?.level as ConfidenceLevel)) {
        errors.push(`invalid confidence.level: "${envelope.confidence?.level}"`);
      }
      for (const gap of envelope.gaps || []) {
        if (!(VALID_GAP_IMPACTS as readonly string[]).includes(gap.impact)) {
          errors.push(`invalid gap.impact: "${gap.impact}" on dimension "${gap.dimension}"`);
        }
      }

      // Verify quality derivation matches
      const nullGaps = detectNullGaps(envelope.payload);
      const existingDimensions = new Set(envelope.gaps.map(g => g.dimension));
      const allGaps = [...envelope.gaps, ...nullGaps.filter(g => !existingDimensions.has(g.dimension))];
      const expectedQuality = deriveQuality(allGaps, envelope.confidence);
      if (envelope.quality !== expectedQuality) {
        errors.push(`quality inflation: stored "${envelope.quality}" but deriveQuality() returns "${expectedQuality}"`);
      }
    } catch (e) {
      errors.push(`read/parse error: ${(e as Error).message}`);
    }

    results.push({ evidenceId: id, valid: errors.length === 0, errors });
  }

  return results;
}
