// Myers line-level diff for ARIA snapshots.

import type { SnapshotDiffResult } from "../shared/evidence-types.js";

export interface DiffEdit {
  type: "equal" | "insert" | "delete";
  line: string;
}

/**
 * Myers diff algorithm operating on arrays of lines.
 * Returns a minimal edit script.
 */
export function myersDiff(a: string[], b: string[]): DiffEdit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;

  if (max === 0) return [];

  // Optimize: if both are identical, skip diff
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
    const snapshot = new Int32Array(v);
    trace.push(snapshot);

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

      if (x >= n && y >= m) {
        return buildEditScript(trace, a, b, max);
      }
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

    let prevK: number;
    if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevIdx = prevK + max;
    const prevX = v[prevIdx];
    const prevY = prevX - prevK;

    // Diagonal (equal lines)
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

  // Remaining diagonal at d=0
  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.push({ type: "equal", line: a[x] });
  }

  edits.reverse();
  return edits;
}

/**
 * Produce a unified diff string and stats from two snapshot texts.
 */
export function diffSnapshots(before: string, after: string): SnapshotDiffResult {
  const linesA = before.split("\n");
  const linesB = after.split("\n");

  const edits = myersDiff(linesA, linesB);

  let additions = 0;
  let removals = 0;
  let unchanged = 0;
  const diffLines: string[] = [];

  for (const edit of edits) {
    switch (edit.type) {
      case "equal":
        unchanged++;
        diffLines.push(`  ${edit.line}`);
        break;
      case "insert":
        additions++;
        diffLines.push(`+ ${edit.line}`);
        break;
      case "delete":
        removals++;
        diffLines.push(`- ${edit.line}`);
        break;
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
