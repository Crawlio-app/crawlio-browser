// Myers line-level diff for ARIA snapshots.
//
// This lives in shared/ because both halves of Crawlio need the same semantics:
// the MCP server exposes diff_snapshot, while extension-resident monitors compare
// captures even when no MCP process is connected.

import type { SnapshotDiffResult } from "./evidence-types.js";

export interface DiffEdit {
  type: "equal" | "insert" | "delete";
  line: string;
}

/** Return a minimal line-level edit script for two arrays. */
export function myersDiff(a: string[], b: string[]): DiffEdit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;

  if (max === 0) return [];

  if (n === m) {
    let identical = true;
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return a.map((line) => ({ type: "equal" as const, line }));
  }

  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  v.fill(-1);
  const trace: Int32Array[] = [];

  v[max + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(v));

    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;

      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      v[idx] = x;
      if (x >= n && y >= m) return buildEditScript(trace, a, b, max);
    }
  }

  return buildEditScript(trace, a, b, max);
}

function buildEditScript(trace: Int32Array[], a: string[], b: string[], max: number): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const idx = k + max;
    const prevK = k === -d || (k !== d && v[idx - 1] < v[idx + 1]) ? k + 1 : k - 1;
    const prevX = v[prevK + max];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ type: "equal", line: a[x] });
    }

    if (x === prevX) {
      y--;
      edits.push({ type: "insert", line: b[y] });
    } else {
      x--;
      edits.push({ type: "delete", line: a[x] });
    }
  }

  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.push({ type: "equal", line: a[x] });
  }

  edits.reverse();
  return edits;
}

/** Produce a unified diff string and stats from two snapshot texts. */
export function diffSnapshots(before: string, after: string): SnapshotDiffResult {
  const edits = myersDiff(before.split("\n"), after.split("\n"));
  let additions = 0;
  let removals = 0;
  let unchanged = 0;
  const diffLines: string[] = [];

  for (const edit of edits) {
    if (edit.type === "equal") {
      unchanged++;
      diffLines.push(`  ${edit.line}`);
    } else if (edit.type === "insert") {
      additions++;
      diffLines.push(`+ ${edit.line}`);
    } else {
      removals++;
      diffLines.push(`- ${edit.line}`);
    }
  }

  return {
    diff: diffLines.join("\n"),
    additions,
    removals,
    unchanged,
    changed: additions > 0 || removals > 0,
  };
}
