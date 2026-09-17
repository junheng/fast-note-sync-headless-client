import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

// Creates a new Windows-native test vault/profile from WSL. No default Obsidian
// profile is read. The separate host probe only observes this fresh test vault.
const root = process.argv[2];
if (!root || !path.isAbsolute(root) || path.basename(root) !== "fns-headless-acceptance" || fs.existsSync(root)) throw new Error("A new, absolute acceptance directory is required");
const win = value => execFileSync("wslpath", ["-w", value], { encoding: "utf8" }).trim();
const vault = path.join(root, "vault"), profile = path.join(root, "profile"), receipts = path.join(root, "receipts");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = fs.readFileSync("main.js");
const pluginDirectory = path.join(vault, ".obsidian", "plugins", manifest.id);
fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(receipts, { mode: 0o700 });
const json = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
json(path.join(root, "acceptance-marker.json"), { schemaVersion: 1, purpose: "fns-isolated-acceptance" });
fs.writeFileSync(path.join(pluginDirectory, "main.js"), bundle, { mode: 0o600, flag: "wx" });
fs.copyFileSync("manifest.json", path.join(pluginDirectory, "manifest.json"));
if (fs.existsSync("styles.css")) fs.copyFileSync("styles.css", path.join(pluginDirectory, "styles.css"));
json(path.join(pluginDirectory, "data.json"), { api: "", apiToken: "", vault: "", syncEnabled: false, configSyncEnabled: false, manualSyncEnabled: true, logEnabled: "off", showUpgradeBadge: false, offlineSyncStrategy: "manualMerge" });
json(path.join(profile, "obsidian.json"), { vaults: { [randomBytes(8).toString("hex")]: { path: win(vault), ts: Date.now(), open: true } }, updateDisabled: true });
json(path.join(vault, ".obsidian", "community-plugins.json"), [manifest.id, "fns-acceptance-probe"]);
json(path.join(vault, ".obsidian", "core-plugins.json"), []);
json(path.join(vault, ".obsidian", "app.json"), {});
const probe = path.join(vault, ".obsidian", "plugins", "fns-acceptance-probe"); fs.mkdirSync(probe);
json(path.join(probe, "manifest.json"), { id: "fns-acceptance-probe", name: "Isolated acceptance probe", version: "0.0.1", minAppVersion: "1.8.7", description: "Records host loading only in the isolated fixture vault.", author: "Headless acceptance", isDesktopOnly: true });
const probeSource = `const {Plugin,apiVersion}=require('obsidian');
module.exports=class extends Plugin {
 onload() { this.app.workspace.onLayoutReady(()=>{this.registerInterval(setInterval(()=>{
  const vaultMatches=this.app.vault.adapter.getBasePath()===${JSON.stringify(win(vault))};
  const dataDirMatches=require('@electron/remote').app.getPath('userData')===${JSON.stringify(win(profile))};
  if(!vaultMatches || !dataDirMatches) return;
  const plugin=this.app.plugins.plugins['fast-note-sync'];
  require('fs').writeFileSync(${JSON.stringify(win(path.join(receipts, 'plugin-host.json')))},JSON.stringify({schemaVersion:1,host:'Obsidian',hostVersion:apiVersion,pluginVersion:plugin?.manifest.version??null,pluginLoaded:!!plugin,vaultMatches,dataDirMatches,syncEnabled:plugin?.settings.syncEnabled??null,configSyncEnabled:plugin?.settings.configSyncEnabled??null}));
 },1000));}); }
};
`;
fs.writeFileSync(path.join(probe, "main.js"), probeSource, { mode: 0o600, flag: "wx" });
json(path.join(receipts, "build.json"), { schemaVersion: 1, pluginVersion: manifest.version, bundleSha256: createHash("sha256").update(bundle).digest("hex"), upstreamCommit: "f2b15c09d34e621d2d97ad526fdee03460bac151", syncEnabled: false });
console.log("Status: isolated Obsidian profile and plugin prepared; synchronization disabled");
