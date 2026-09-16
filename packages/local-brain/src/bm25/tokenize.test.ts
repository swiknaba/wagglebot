import { expect, test } from "bun:test";
import { tokenize } from "./tokenize";

test("keeps identifiers whole and adds camel and snake segments", () => {
  expect(tokenize("TokenService.rotate refresh_token abc1234")).toEqual([
    "tokenservice",
    "token",
    "service",
    "rotate",
    "refresh_token",
    "refresh",
    "token",
    "abc1234",
  ]);
});

test("retains Unicode letters and numbers", () => {
  expect(tokenize("Café Ωmega 版本2")).toEqual(["café", "ωmega", "版本2"]);
});

test("keeps commit hashes and paths searchable as exact terms", () => {
  const tokens = tokenize("Fix 9f8e7d6 in src/auth/token-service.ts");

  expect(tokens).toContain("9f8e7d6");
  expect(tokens).toContain("src/auth/token-service.ts");
  expect(tokens).toContain("token-service");
});

test("handles long punctuation runs without regex backtracking", () => {
  expect(tokenize(`${"-".repeat(100_000)}token`)).toEqual(["token"]);
});
