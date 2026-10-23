import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ChatGPTStatus } from "../src/core/contracts/chatgpt.ts";
const temp = mkdtempSync(path.join(tmpdir(), "lh-subscription-catalog-"));
process.env.LH_DATA_DIR = temp;
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
process.env.LH_CHATGPT_DESKTOP = "1";
delete process.env.OPENAI_API_KEY;
after(() => rmSync(temp, { recursive: true, force: true }));
const { chatGPTStatus } = await import("../src/agent/chatgpt-connection.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
chatGPTStatus();
function update(patch: Partial<ChatGPTStatus>) {
	EventEmitter.prototype.emit.call(process, "message", { channel: "lh:chatgpt", event: "status", status: { desktop: true, mode: "chatgpt", selectedId: "account-a", authenticated: true, planPermission: true, pending: false, message: null, accounts: [], modelIds: ["gpt-4o-mini", "unsupported-future-model"], modelNames: { "gpt-4o-mini": "Account model name" }, ...patch } });
}
test("live account models intersect Pi metadata; connection does not pretend a key exists", () => {
	update({});
	const catalog = modelCatalog();
	const provider = catalog.providers.find((p) => p.id === "openai")!;
	assert.equal(provider.keyPresent, false); assert.equal(provider.available, true); assert.equal(provider.authentication, "chatgpt");
	const models = catalog.models.filter((m) => m.provider === "openai");
	assert.deepEqual(models.map((m) => m.id), ["gpt-4o-mini"]);
	assert.equal(models[0]!.name, "Account model name"); assert.ok(models[0]!.input.includes("image"));
	assert.equal(models[0]!.costBasis, "api_equivalent"); assert.equal(providerKeyPresent("openai"), true);
});
test("logout cannot expose saved API-key models until API billing is selected explicitly", () => {
	process.env.OPENAI_API_KEY = "sk-fixture-never-send";
	update({ authenticated: false, modelIds: [] });
	assert.equal(providerKeyPresent("openai"), false);
	assert.equal(modelCatalog().models.some((m) => m.provider === "openai"), false);
	update({ mode: "api_key" });
	assert.equal(providerKeyPresent("openai"), true);
	assert.ok(modelCatalog().models.some((m) => m.provider === "openai"));
	delete process.env.OPENAI_API_KEY;
});
