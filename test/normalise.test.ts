import { test } from "node:test";
import assert from "node:assert/strict";
import { tidyAttempt } from "../src/normalise.ts";

test("capitalises the first letter and adds a final full stop", () => {
  assert.equal(tidyAttempt("the ball was in play"), "The ball was in play.");
});

test("keeps existing terminal punctuation and collapses whitespace", () => {
  assert.equal(tidyAttempt("  Is it   true?  "), "Is it true?");
  assert.equal(tidyAttempt('he said "hello"'), 'He said "hello"');
});

test("returns an empty string for blank input and never changes the words", () => {
  assert.equal(tidyAttempt("   "), "");
  const text = "fifty-seven minutes, and seven seconds";
  assert.equal(tidyAttempt(text).toLowerCase().replace(/\.$/, ""), text);
});
