import { expect, test } from "bun:test";
import { createSecretScanner, ScannerUnavailableError } from "./index";

test("public pinned scanner fails closed with the exported safe error", async () => {
  const scanner = createSecretScanner({
    gitleaks: { executable: "unused", version: "unsupported", sha256: "" },
  });

  try {
    await scanner.assertReady();
    throw new Error("expected scanner rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ScannerUnavailableError);
    expect(error).toMatchObject({ code: "scanner_unavailable", message: "scanner unavailable" });
  }
});
