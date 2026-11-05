import { expect, test } from "bun:test";
import { matchRanges } from "../src/match-style";

test("every occurrence is found, ignoring case, without overlapping", () => {
  expect(matchRanges("Needle and needle, NEEDLE", "needle")).toEqual([
    [0, 6],
    [11, 17],
    [19, 25],
  ]);
  expect(matchRanges("aaaa", "aa")).toEqual([
    [0, 2],
    [2, 4],
  ]);
});

test("nothing is marked for an empty query, or when lower case would shift the positions", () => {
  expect(matchRanges("text", "")).toEqual([]);
  expect(matchRanges("no match here", "needle")).toEqual([]);
  // "İ" becomes two characters in lower case, so every later offset would be wrong.
  expect(matchRanges("İ needle", "needle")).toEqual([]);
});
