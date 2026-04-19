import assert from "node:assert/strict";
import test from "node:test";

import { InvalidName } from "../src/errors";
import { validateSessionName } from "../src/workspace";

test("validateSessionName accepts path-safe names", () => {
  for (const name of ["a", "alpha", "alpha_1", "alpha-1", "alpha.1", "_scratch", "A_0123456789"]) {
    assert.equal(validateSessionName(name), name);
  }
});

test("validateSessionName rejects traversal, reserved, and Windows-unsafe names", () => {
  const bad = [
    "",
    ".",
    "..",
    "-dash",
    " space",
    "space ",
    "a/",
    "a\\b",
    "a:b",
    "a*b",
    "a?b",
    "a\"b",
    "a<b",
    "a>b",
    "a|b",
    "CON",
    "con",
    "NUL",
    "COM1",
    "LPT9",
    "x".repeat(65),
  ];
  for (const name of bad) {
    assert.throws(() => validateSessionName(name), InvalidName, name);
  }
});
