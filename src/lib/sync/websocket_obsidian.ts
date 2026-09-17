import { moment } from "obsidian";
import { dump, dumpError, showSyncNotice } from "../utils/helpers";
import { WebSocketClient } from "./websocket_client";
import type { WebSocketClientOptions } from "./websocket_client";

export interface AppStoragePlugin {
  app: {
    vault: {
      getName: () => string;
    };
    loadLocalStorage: (key: string) => unknown;
    saveLocalStorage: (key: string, value: string | null) => void;
  };
  settings?: {
    protobufEnabled?: boolean;
  };
}

function getWsCountStorageKey(plugin: AppStoragePlugin): string {
  const vaultName = plugin.app.vault.getName();
  return `fns-${vaultName}-wsCount`;
}

export function createObsidianWebSocketClient(plugin: AppStoragePlugin, options: WebSocketClientOptions): WebSocketClient {
  return new WebSocketClient({
    loadCount: () => {
      const storageKey = getWsCountStorageKey(plugin);
      let storedCount = plugin.app.loadLocalStorage(storageKey) as string | null;

      // 迁移逻辑：如果新键无值，尝试按顺序读取旧键
      if (storedCount === null) {
        const vaultName = plugin.app.vault.getName();
        // 1. 尝试上一个格式: fast-note-sync-[Vault]-wsCount
        const prevKey1 = `fast-note-sync-${vaultName}-wsCount`;
        let oldValue = plugin.app.loadLocalStorage(prevKey1) as string | null;

        // 2. 尝试更早的格式: fast-note-sync-[Vault]-ws-count
        if (oldValue === null) {
          const prevKey2 = `fast-note-sync-${vaultName}-ws-count`;
          oldValue = plugin.app.loadLocalStorage(prevKey2) as string | null;
        }

        // 3. 尝试最初始格式: fast-note-sync-ws-count
        if (oldValue === null) {
          const oldKey = "fast-note-sync-ws-count";
          oldValue = plugin.app.loadLocalStorage(oldKey) as string | null;
        }

        if (oldValue !== null) {
          storedCount = oldValue;
          plugin.app.saveLocalStorage(storageKey, storedCount);
        }
      }

      return storedCount ? parseInt(storedCount) : 0;
    },
    saveCount: count => plugin.app.saveLocalStorage(getWsCountStorageKey(plugin), count.toString()),
    protobufEnabled: () => plugin.settings?.protobufEnabled !== false,
  }, options, {
    createSocket: url => new WebSocket(url),
    timestamp: () => (moment as unknown as () => { format(pattern: string): string })().format("YYYY-MM-DD HH:mm:ss.SSS"),
    debug: dump,
    error: dumpError,
    notice: showSyncNotice,
  });
}
