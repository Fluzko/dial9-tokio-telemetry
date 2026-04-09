"use strict";

class TestFailure extends Error {
  constructor(msg) {
    super(msg);
    this.name = "TestFailure";
  }
}

let passed = 0;
let failed = 0;
let depth = 0;

function indent() {
  return "  ".repeat(depth);
}

function describe(name, fn) {
  console.log(`\n${indent()}${name}:`);
  depth++;
  fn();
  depth--;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`${indent()}  ✓ ${name}`);
  } catch (e) {
    failed++;
    const detail = e instanceof TestFailure ? e.message : String(e);
    console.log(`${indent()}  ✗ ${name}: ${detail}`);
  }
}

function fail(msg) {
  throw new TestFailure(msg);
}

function run() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

module.exports = { describe, test, fail, run };
