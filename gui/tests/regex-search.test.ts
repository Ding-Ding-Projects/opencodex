import { expect, test } from "bun:test";
import { compileBoundedRegex } from "../src/regex-search";

test("plain-text mode keeps regex evaluation disabled", () => {
  expect(compileBoundedRegex({ enabled: false, pattern: ".*", flags: "i" })).toBeNull();
});

test("valid Unicode and multiline patterns compile with synchronized flags", () => {
  const regex = compileBoundedRegex({ enabled: true, pattern: "^模型|ready$", flags: "imu" });
  expect(regex).toBeInstanceOf(RegExp);
  expect(regex?.test("模型 alpha\nREADY")).toBe(true);
});

test("global state is removed for repeatable row filtering", () => {
  const regex = compileBoundedRegex({ enabled: true, pattern: "model", flags: "gi" });
  expect(regex?.global).toBe(false);
  expect(regex?.test("MODEL")).toBe(true);
  expect(regex?.test("MODEL")).toBe(true);
});

test("invalid syntax, unsupported flags, empty patterns, and oversized patterns fail closed", () => {
  expect(compileBoundedRegex({ enabled: true, pattern: "(", flags: "i" })).toBeNull();
  expect(compileBoundedRegex({ enabled: true, pattern: "model", flags: "z" })).toBeNull();
  expect(compileBoundedRegex({ enabled: true, pattern: "", flags: "i" })).toBeNull();
  expect(compileBoundedRegex({ enabled: true, pattern: "x".repeat(513), flags: "i" })).toBeNull();
});

test("zero-width patterns compile without looping in row filtering", () => {
  const regex = compileBoundedRegex({ enabled: true, pattern: "^", flags: "u" });
  expect(regex?.test("model")).toBe(true);
});
