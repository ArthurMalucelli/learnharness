/** Sign outside file-provider-managed folders: iCloud/Dropbox can reattach
 * FinderInfo while codesign is running. Only sealed archives return to dist/. */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const staging = mkdtempSync(path.join(tmpdir(), "learnharness-local-"));
const output = path.join(root, "dist");
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("electron-builder/package.json")), "out", "cli", "cli.js");
const result = spawnSync(process.execPath, [cli, "--config", "electron-builder.local.yml", `--config.directories.output=${staging}`, "--mac", "--arm64", "--publish", "never"], {
	cwd: root, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" },
});
if (result.status !== 0) process.exit(result.status ?? 1);
const app = path.join(staging, "mac-arm64", "LearnHarness.app");
const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
if (verify.status !== 0) process.exit(verify.status ?? 1);
mkdirSync(output, { recursive: true });
const artifacts = readdirSync(staging).filter((name) => /\.(dmg|zip|blockmap)$/.test(name));
for (const name of artifacts) copyFileSync(path.join(staging, name), path.join(output, name));
writeFileSync(path.join(output, "local-build.json"), JSON.stringify({ app, artifacts }, null, 2) + "\n");
console.log(`[local-package] verified app: ${app}`);
console.log(`[local-package] archives: ${output}`);
