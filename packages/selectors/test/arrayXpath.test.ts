import { describe, it, expect } from "vitest";
import {
  partOfSameArrayXpath,
  generalizeArrayXpath,
  verifyThatAllXpathsArePartOfSameArray,
} from "../src/arrayXpath";

describe("array-xpath generalization", () => {
  it("detects two xpaths that are items of the same array", () => {
    expect(
      partOfSameArrayXpath("/html/body/ul/li[1]/a", "/html/body/ul/li[3]/a")
    ).toBe(true);
  });

  it("generalizes pick-2-rows into one list xpath", () => {
    expect(
      generalizeArrayXpath(["/html/body/ul/li[1]/a", "/html/body/ul/li[3]/a"])
    ).toBe("/html/body/ul/li/a");
  });

  it("generalizes 3+ picks in the same array", () => {
    expect(
      generalizeArrayXpath(["/x/li[1]/a", "/x/li[2]/a", "/x/li[5]/a"])
    ).toBe("/x/li/a");
  });

  it("returns null when picks are not a clean array (structural diff)", () => {
    expect(generalizeArrayXpath(["/a/b", "/a/c"])).toBeNull();
    expect(verifyThatAllXpathsArePartOfSameArray(["/a/b", "/a/c"])).toBe(false);
  });

  it("treats identical paths as not-an-array", () => {
    expect(partOfSameArrayXpath("/a/b[1]", "/a/b[1]")).toBe(false);
  });
});
