import { expect, test } from "bun:test";
import { isReservedExampleUrl, resolveCompanyRepositoryUrl } from "./company-url";

const metadata = {
  version: "0.2.1",
  wagglebot: { companyRepository: "git@metadata.example.invalid:platform/company.git" },
};

test("environment URL wins over saved and package URLs", () => {
  expect(
    resolveCompanyRepositoryUrl({
      env: { WAGGLEBOT_COMPANY_REPOSITORY_URL: "git@env.example.invalid:platform/company.git" },
      config: { companyRepository: "git@saved.example.invalid:platform/company.git" },
      packageMetadata: metadata,
    }),
  ).toBe("git@env.example.invalid:platform/company.git");
});

test("saved URL wins over package metadata", () => {
  expect(
    resolveCompanyRepositoryUrl({
      env: {},
      config: { companyRepository: "git@saved.example.invalid:platform/company.git" },
      packageMetadata: metadata,
    }),
  ).toBe("git@saved.example.invalid:platform/company.git");
});

test("package metadata supplies the fallback URL", () => {
  expect(
    resolveCompanyRepositoryUrl({
      env: {},
      config: {},
      packageMetadata: {
        version: "0.2.1",
        wagglebot: { companyRepository: "git@company.internal:platform/company.git" },
      },
    }),
  ).toBe("git@company.internal:platform/company.git");
});

test("recognizes reserved example hosts in SSH and HTTPS forms", () => {
  expect(isReservedExampleUrl("git@company.example:platform/mycompany-wagglebot.git")).toBe(true);
  expect(isReservedExampleUrl("https://company.example/platform/mycompany-wagglebot.git")).toBe(true);
});

test("recognizes a reserved host-only SCP input", () => {
  expect(isReservedExampleUrl("git@company.example")).toBe(true);
  expect(() =>
    resolveCompanyRepositoryUrl({
      env: { WAGGLEBOT_COMPANY_REPOSITORY_URL: "git@company.example" },
      config: {},
      packageMetadata: { version: "0.2.1" },
    }),
  ).toThrow('Run "wagglebot connect <git-url>" first.');
});

test("reserved example URLs count as unset and are never returned", () => {
  expect(() =>
    resolveCompanyRepositoryUrl({
      env: { WAGGLEBOT_COMPANY_REPOSITORY_URL: "git@company.example:platform/company.git" },
      config: { companyRepository: "https://nested.company.example/platform/company.git" },
      packageMetadata: {
        version: "0.2.1",
        wagglebot: { companyRepository: "git@company.example:platform/company.git" },
      },
    }),
  ).toThrow('Run "wagglebot connect <git-url>" first.');
});

test("missing usable URL asks the engineer to connect", () => {
  expect(() => resolveCompanyRepositoryUrl({ env: {}, config: {}, packageMetadata: { version: "0.2.1" } })).toThrow(
    'Run "wagglebot connect <git-url>" first.',
  );
});
