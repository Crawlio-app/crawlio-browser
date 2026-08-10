// Kept as a compatibility import path for server code and downstream tests.
// The implementation is shared with the extension-resident monitor.
export { diffSnapshots, myersDiff } from "../shared/snapshot-diff.js";
export type { DiffEdit } from "../shared/snapshot-diff.js";
