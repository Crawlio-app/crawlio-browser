// Array-XPath generalization — turn N picked siblings into one index-stripped
// xpath that matches the whole repeating set.
//
// Ported from Selector Forge (MIT, © The Metrics Shop, Inc.). Pure string
// logic, no DOM dependency.

/**
 * True iff two xpaths describe siblings in the same array — identical structure
 * differing by exactly one numeric value (the sibling index) in one segment.
 */
export function partOfSameArrayXpath(str1: string, str2: string): boolean {
  if (str1 === str2) return false; // identical paths aren't two array items

  const parts1 = str1.split("/");
  const parts2 = str2.split("/");

  if (parts1.length !== parts2.length) return false; // different structure

  let numericDifferences = 0;
  for (let i = 0; i < parts1.length; i++) {
    if (parts1[i] !== parts2[i]) {
      const regex = /\d+/g; // Match all digit sequences in the segment.
      const numbers1 = (parts1[i].match(regex) || []).map(Number);
      const numbers2 = (parts2[i].match(regex) || []).map(Number);

      if (numbers1.length !== numbers2.length) return false;

      let segmentDifferences = 0;
      for (let j = 0; j < numbers1.length; j++) {
        if (numbers1[j] !== numbers2[j]) segmentDifferences++;
      }

      if (segmentDifferences === 0) return false; // differs but not numerically — structural
      if (segmentDifferences > 1) return false; // more than one numeric diff in a segment

      numericDifferences += segmentDifferences;
      if (numericDifferences > 1) return false; // more than one numeric diff overall
    }
  }

  return numericDifferences === 1; // exactly one numeric difference
}

/** True iff every xpath belongs to the same array as the first one. */
export function verifyThatAllXpathsArePartOfSameArray(
  xpaths: string[]
): boolean {
  if (xpaths.length < 2) return false;
  const firstPath = xpaths[0]; // anchor for comparison
  for (let i = 1; i < xpaths.length; i++) {
    if (!partOfSameArrayXpath(xpaths[i], firstPath)) {
      return false;
    }
  }
  return true;
}

/**
 * Build the index-stripped xpath that matches every item in the array, or null
 * if the picks don't form a clean array (varied structure, or varying in more
 * than one segment). e.g. ["…/ul/li[1]/a", "…/ul/li[3]/a"] -> "…/ul/li/a".
 */
export function generalizeArrayXpath(xpaths: string[]): string | null {
  if (!verifyThatAllXpathsArePartOfSameArray(xpaths)) return null;

  const split = xpaths.map((x) => x.split("/"));
  const base = split[0];

  // Collect every segment position that varies across the whole set. A clean
  // array varies in exactly one segment; bail otherwise.
  const diffPositions = new Set<number>();
  for (const parts of split) {
    for (let i = 0; i < base.length; i++) {
      if (parts[i] !== base[i]) diffPositions.add(i);
    }
  }
  if (diffPositions.size !== 1) return null;

  const [pos] = diffPositions;
  const generalized = [...base];
  // Drop the sibling index so the segment matches every item in the array.
  generalized[pos] = base[pos].replace(/\[\d+\]/g, "");
  return generalized.join("/");
}
