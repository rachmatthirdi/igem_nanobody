// Tests for renderer/js/aa.js, the three-letter to one-letter amino-acid table
// shared by the main process (require) and the renderer (<script>).
//
// Run from the repository root:  node tests/aa.test.js
// Uses only Node's built-in test runner, so no extra dependency is needed.

const test = require("node:test");
const assert = require("node:assert/strict");
const AA_3TO1 = require("../renderer/js/aa.js");

const STANDARD = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C",
  GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P",
  SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
};

test("maps all 20 standard residues to the correct one-letter code", () => {
  for (const [three, one] of Object.entries(STANDARD)) {
    assert.equal(AA_3TO1[three], one, `${three} should map to ${one}`);
  }
});

test("reads selenomethionine (MSE) as methionine", () => {
  assert.equal(AA_3TO1.MSE, "M");
});

test("every value is a single uppercase letter", () => {
  for (const [three, one] of Object.entries(AA_3TO1)) {
    assert.match(one, /^[A-Z]$/, `${three} -> ${one}`);
  }
});

test("every key is a three-letter uppercase code", () => {
  for (const key of Object.keys(AA_3TO1)) {
    assert.match(key, /^[A-Z]{3}$/, key);
  }
});

test("an unknown residue is absent so callers can fall back to X", () => {
  assert.equal(AA_3TO1.HOH, undefined);
});
