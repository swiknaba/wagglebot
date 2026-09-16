export interface SshSigner {
  sign(payload: Uint8Array, signal: AbortSignal): Promise<string>;
}
