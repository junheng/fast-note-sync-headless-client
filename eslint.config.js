import obsidianmd from "eslint-plugin-obsidianmd";
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";


export default defineConfig([
  {
    ignores: [
      "src/pb/**",
      "main.js",
      "styles.css",
      "dist/**",
      "src/lib/helpers_obsidian_bypass.js"
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["src/pb/**"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        process: "readonly",
      },
    },

    // You can add your own configuration to override or add rules
    rules: {
      // example: turn off a rule from the recommended set
      "obsidianmd/sample-names": "off",
      // example: add a rule not in the recommended set and set its severity
      "obsidianmd/prefer-file-manager-trash-file": "error",
    },
  },
  {
    files: ["src/headless/**/*.ts", "src/lib/utils/protocol_hash.ts", "src/lib/sync/websocket_client.ts", "src/lib/sync/batch_sync.ts"],
    rules: {
      // Shared and Node modules cannot use the Obsidian window timer API.
      // Keep this rule enabled for the plugin adapters and the rest of the plugin.
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  {
    files: ["src/headless/remote.ts"],
    rules: {
      // This Node-only HTTP adapter must use native fetch. The inherited rule
      // recommends Obsidian requestUrl, which cannot run in this host.
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["src/headless/**/*.ts"],
    rules: {
      // This entry is a Node process; mobile restrictions still apply to every
      // plugin/shared module, preventing accidental Node imports into Obsidian.
      "obsidianmd/no-nodejs-modules": "off",
      // Headless excludes the default plugin configuration directory explicitly.
      "obsidianmd/hardcoded-config-path": "off",
    },
  },
]);
