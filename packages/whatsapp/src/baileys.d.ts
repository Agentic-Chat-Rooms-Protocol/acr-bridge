declare module '@whiskeysockets/baileys' {
  export const DisconnectReason: {
    loggedOut: number;
    connectionReplaced: number;
    multideviceMismatch: number;
    restartRequired: number;
  };
  export function makeWASocket(config: Record<string, unknown>): unknown;
  export function useMultiFileAuthState(folder: string): Promise<{
    state: { creds: { registered?: boolean }; keys: unknown };
    saveCreds: () => Promise<void>;
  }>;
  export function makeCacheableSignalKeyStore(keys: unknown, logger: unknown): unknown;
  export function downloadMediaMessage(
    message: unknown,
    type: 'buffer' | 'stream',
    options: Record<string, unknown>,
  ): Promise<Buffer>;
}
