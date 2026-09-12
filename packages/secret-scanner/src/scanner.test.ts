import { expect, test } from "bun:test";
import { assertSafeText, scanText } from "./index";

test("accepts empty and ordinary text", () => {
  expect(scanText("")).toEqual({ findings: [], count: 0 });
  expect(scanText("Synthetic fixture content\nwith ordinary prose.")).toEqual({ findings: [], count: 0 });
  expect(() => assertSafeText("")).not.toThrow();
});

test("reports stable rules and locations for control and credential-like text", () => {
  const findings = scanText(
    "safe\n\u0000\n-----BEGIN PRIVATE KEY-----\nAKIA0123456789ABCDEF\ntoken = placeholder\npassword: synthetic-password\nclient_secret=G7vZ0n3M9qL2rT5xC8kP1wD4fH6jN0sB",
  );

  expect(findings.count).toBe(6);
  expect(findings.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ruleId: "nul_character", line: 2, column: 1 }),
      expect.objectContaining({ ruleId: "pem_private_key", line: 3, column: 1 }),
      expect.objectContaining({ ruleId: "cloud_access_key", line: 4, column: 1 }),
      expect.objectContaining({ ruleId: "token_assignment", line: 5, column: 1 }),
      expect.objectContaining({ ruleId: "password_assignment", line: 6, column: 1 }),
      expect.objectContaining({ ruleId: "high_entropy_credential", line: 7, column: 1 }),
    ]),
  );
});

test("detects environment-style credential assignments without exposing their values", () => {
  const value = "G7vZ0n3M9qL2rT5xC8kP1wD4fH6jN0sB";
  const result = scanText(`MCP_TOKEN=${value}\nACCESS_TOKEN=${value}\nDATABASE_PASSWORD=synthetic-password`);

  expect(result).toEqual({
    findings: [
      { ruleId: "high_entropy_credential", line: 1, column: 1 },
      { ruleId: "token_assignment", line: 1, column: 1 },
      { ruleId: "high_entropy_credential", line: 2, column: 1 },
      { ruleId: "token_assignment", line: 2, column: 1 },
      { ruleId: "password_assignment", line: 3, column: 1 },
    ],
    count: 5,
  });
  expect(JSON.stringify(result)).not.toContain(value);
});

test("rejects other control characters and never exposes matched secret text", () => {
  const secret = "Bearer synthetic-token-value-123456";
  const result = scanText(`prefix\u0007\n${secret}`);

  expect(result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ruleId: "control_character", line: 1, column: 7 }),
      expect.objectContaining({ ruleId: "bearer_token", line: 2, column: 1 }),
    ]),
  );
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(() => assertSafeText(secret)).toThrow("unsafe text: bearer_token");
  expect(() => assertSafeText(secret)).not.toThrow(secret);
});
