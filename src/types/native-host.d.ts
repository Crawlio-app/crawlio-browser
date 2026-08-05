// Ambient types for the plain-ESM native-host helpers (bin/native-host/provision.mjs),
// which live outside the TS root so the staged host stays dependency-free.
declare module "*/provision.mjs" {
  export interface LiveBridge {
    port: number;
    token: string;
    pid: number;
    lastActivityAt: number;
  }
  export function defaultIsPidAlive(pid: number): boolean;
  export function listLiveBridges(
    bridgesDir: string,
    isPidAlive?: (pid: number) => boolean,
    readDir?: (p: string) => string[],
    readFile?: (p: string, enc: string) => string,
  ): LiveBridge[];
  export function validateBridgeViaHealth(
    bridge: { port: number; pid: number },
    fetchFn?: typeof fetch,
  ): Promise<boolean>;
  export function selectProvisionableBridge(
    bridgesDir: string,
    deps?: Record<string, unknown>,
  ): Promise<{ port: number; token: string } | null>;
  export function encodeNativeMessage(obj: unknown): Buffer;
  export function decodeNativeMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer };
  export const HOST_NAME: string;
  export function targetDirs(
    env?: Record<string, string | undefined>,
    exists?: (p: string) => boolean,
    home?: () => string,
  ): string[];
}
