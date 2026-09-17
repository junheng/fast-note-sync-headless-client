import fs from "node:fs";

// Application credential consumer. Values never leave the process through logs,
// command arguments, receipts or generated files. Caller must sanitize errors.
export function fnsCredentials(args = process.argv.slice(2), env = process.env) {
  let config;
  if (args.length === 0 && env.FNS_CREDENTIALS_FILE) {
    if (env.FNS_TOKEN || env.FNS_TOKEN_FILE || env.FNS_ENDPOINT || env.FNS_VAULT) throw Object.assign(new Error(), { code: "invalid-config" });
    args = ["--credentials-json", env.FNS_CREDENTIALS_FILE];
  }
  if (args.length === 0) {
    let token = env.FNS_TOKEN;
    if (env.FNS_TOKEN_FILE) {
      if (token) throw Object.assign(new Error(), { code: "invalid-config" });
      let fd;
      try {
        fd = fs.openSync(env.FNS_TOKEN_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error();
        token = fs.readFileSync(fd, "utf8").trim();
      } catch { throw Object.assign(new Error(), { code: "invalid-config" }); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    config = { api: env.FNS_ENDPOINT, apiToken: token, vault: env.FNS_VAULT };
  }
  else {
    if (args.length !== 2 || args[0] !== "--credentials-json") throw Object.assign(new Error(), { code: "invalid-config" });
    let fd;
    try {
      fd = fs.openSync(args[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error();
      config = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch { throw Object.assign(new Error(), { code: "invalid-config" }); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  if (!config || !["api", "apiToken", "vault"].every(key => typeof config[key] === "string" && config[key].length > 0)) throw Object.assign(new Error(), { code: "invalid-config" });
  return { endpoint: config.api, token: config.apiToken, vault: config.vault };
}
