export class MemoryServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "MemoryServiceError";
  }
}
