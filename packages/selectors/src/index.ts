// @crawlio/selectors — the shared selector kernel.
//
// Verification-gated selector primitives shared by the Crawlio browser agent
// and the headless engine. Deterministic, dependency-light (zod only), and
// framework-agnostic. The doctrine: propose candidates, then VERIFY them
// against the live DOM with `resolvesExactlyTo` before trusting any of them.

export { computeXPath } from "./xpath.js";
export {
  partOfSameArrayXpath,
  verifyThatAllXpathsArePartOfSameArray,
  generalizeArrayXpath,
} from "./arrayXpath.js";
export { queryAll, resolvesExactlyTo, ElementRegistry } from "./elementRegistry.js";
export { buildInspectionView } from "./inspectionView.js";
export type { InspectionTarget } from "./inspectionView.js";
export { predictListMatches } from "./predictListItems.js";
export * from "./contract.js";
