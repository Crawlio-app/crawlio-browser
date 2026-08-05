#!/usr/bin/env npx tsx
/**
 * Generate tool embeddings at build time.
 *
 * Calls Voyage AI (voyage-3-lite) or OpenAI (text-embedding-3-small) to embed
 * all tool descriptions, then writes src/mcp-server/tool-embeddings.json.
 *
 * Usage:
 *   VOYAGE_API_KEY=... npx tsx scripts/generate-embeddings.ts
 *   OPENAI_API_KEY=... npx tsx scripts/generate-embeddings.ts --provider openai
 *
 * If no API key is set, writes a stub file (keyword-only fallback).
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "src", "mcp-server", "tool-embeddings.json");

// --- Tool catalog (names + descriptions extracted from tools.ts) ---

interface ToolEntry {
  name: string;
  description: string;
}

function extractToolCatalog(): ToolEntry[] {
  const toolsPath = join(__dirname, "..", "src", "mcp-server", "tools.ts");
  const source = readFileSync(toolsPath, "utf-8");

  const entries: ToolEntry[] = [];
  // Match tool definitions: name: "...", description: "..."
  const toolRegex = /name:\s*"([^"]+)",\s*\n\s*description:\s*(?:"([^"]+)"|(\[[\s\S]*?\]\.join\())/g;

  let match: RegExpExecArray | null;
  while ((match = toolRegex.exec(source)) !== null) {
    const name = match[1];
    // Simple description (single string)
    const desc = match[2] || name;
    entries.push({ name, description: desc });
  }

  return entries;
}

// --- Embedding providers ---

async function embedVoyage(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "voyage-3-lite",
      input: texts,
      input_type: "document",
    }),
  });

  if (!resp.ok) {
    throw new Error(`Voyage API error: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

async function embedOpenAI(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

// --- Main ---

async function main() {
  const provider = process.argv.includes("--provider")
    ? process.argv[process.argv.indexOf("--provider") + 1]
    : "voyage";

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.VOYAGE_API_KEY;

  const tools = extractToolCatalog();
  console.log(`Found ${tools.length} tools in catalog`);

  if (!apiKey) {
    console.log("No API key found — writing stub embeddings (keyword-only fallback)");
    const stub = {
      model: "stub",
      dimension: 0,
      generated: new Date().toISOString(),
      embeddings: {} as Record<string, number[]>,
    };
    writeFileSync(OUTPUT_PATH, JSON.stringify(stub, null, 2) + "\n");
    console.log(`Wrote stub to ${OUTPUT_PATH}`);
    return;
  }

  const model = provider === "openai" ? "text-embedding-3-small" : "voyage-3-lite";
  console.log(`Generating embeddings with ${model}...`);

  const texts = tools.map((t) => `${t.name}: ${t.description}`);
  const embedFn = provider === "openai" ? embedOpenAI : embedVoyage;
  const vectors = await embedFn(texts, apiKey);

  const dimension = vectors[0]?.length ?? 0;
  const embeddings: Record<string, number[]> = {};
  for (let i = 0; i < tools.length; i++) {
    embeddings[tools[i].name] = vectors[i];
  }

  const asset = {
    model,
    dimension,
    generated: new Date().toISOString(),
    embeddings,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(asset, null, 2) + "\n");
  console.log(`Wrote ${tools.length} embeddings (${dimension}-dim) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Error generating embeddings:", err);
  process.exit(1);
});
