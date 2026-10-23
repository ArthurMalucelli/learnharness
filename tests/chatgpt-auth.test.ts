import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign, createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { test } from "node:test";
const { createChatGPTAuth } = createRequire(import.meta.url)("../electron/chatgpt-auth.cjs");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
const key = randomBytes(32);
const safeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (value: string) => { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
	decryptString: (bytes: Buffer) => { const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
};
function fixture(t: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-chatgpt-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "credentials.enc");
	let authURL: URL;
	let clock = Date.now();
	let refreshes = 0, exchanges = 0, revoked = 0, account = "subject-A", granted = true;
	let badClaim: Record<string, unknown> = {};
	let corruptSignature = false;
	let decline = false, wrongState: boolean | string = false, cancelled = false, failedRefresh = false;
	let releaseRefresh: (() => void) | undefined;
	let refreshWait: Promise<void> | undefined;
	const claims = () => ({ iss: "https://auth.openai.com", sub: account, aud: "issued-client", iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 3600, nonce: authURL.searchParams.get("nonce"), email: `${account}@example.test`, ...badClaim });
	function jwt() { const data = [JSON.stringify({ alg: "RS256", kid: "fixture" }), JSON.stringify(claims())].map((v) => Buffer.from(v).toString("base64url")).join("."); const signature = sign("RSA-SHA256", Buffer.from(data), privateKey); if (corruptSignature) signature[0] = signature[0]! ^ 1; return `${data}.${signature.toString("base64url")}`; }
	const fetcher = async (url: string, options: RequestInit = {}) => {
		if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
		if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
		if (url.endsWith("/models")) return Response.json({ models: [{ slug: "gpt-6.1-sol", visibility: "list" }, { slug: "hidden", visibility: "hide" }] });
		if (url.endsWith("/revoke")) { revoked++; return new Response(null, { status: 200 }); }
		assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
		const body = new URLSearchParams(options.body as URLSearchParams);
		assert.equal(body.get("client_id"), "issued-client");
		assert.equal(body.get("resource"), "https://api.openai.com/v1");
		if (body.get("grant_type") === "refresh_token") {
			refreshes++; await refreshWait;
			if (failedRefresh) return new Response(null, { status: 400 });
			return Response.json({ access_token: `access-rotated-${refreshes}`, refresh_token: `refresh-rotated-${refreshes}`, expires_in: 3600, token_type: "Bearer" });
		}
		exchanges++;
		assert.equal(body.get("redirect_uri"), authURL.searchParams.get("redirect_uri"));
		assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authURL.searchParams.get("code_challenge"));
		return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", id_token: jwt(), expires_in: 3600, token_type: "Bearer", scope: granted ? "openid resource.invoke chatgpt.tokens.use.direct" : "openid resource.invoke" });
	};
	const openExternal = async (url: string) => {
		authURL = new URL(url);
		if (cancelled) { queueMicrotask(() => auth.cancel()); return; }
		const callback = new URL(authURL.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", wrongState ? (typeof wrongState === "string" ? wrongState : "forged") : authURL.searchParams.get("state")!);
		callback.searchParams.set("client_id", "issued-client");
		callback.searchParams.set(decline ? "error" : "code", decline ? "access_denied" : "one-time-code");
		const result = await fetch(callback);
		if (wrongState) { assert.equal(result.status, 400); auth.cancel(); }
	};
	const make = () => createChatGPTAuth({ file, safeStorage, openExternal, fetch: fetcher, now: () => clock });
	let auth = make();
	return { file, get auth() { return auth; }, reload: () => { auth = make(); }, get url() { return authURL; }, get refreshes() { return refreshes; }, get exchanges() { return exchanges; }, get revoked() { return revoked; }, corruptSignature: () => { corruptSignature = true; }, expire: () => { clock += 3590000; }, grant: (v: boolean) => { granted = v; }, badClaim: (v: Record<string, unknown>) => { badClaim = v; }, account: (v: string) => { account = v; }, decline: () => { decline = true; }, wrongState: () => { wrongState = true; }, unicodeState: () => { wrongState = "é".repeat(43); }, cancel: () => { cancelled = true; }, failRefresh: () => { failedRefresh = true; }, holdRefresh: () => { refreshWait = new Promise<void>((resolve) => { releaseRefresh = resolve; }); }, release: () => releaseRefresh?.() };
}

test("verified PKCE sign-in, encrypted owner-only persistence, restart and returning registration", async (t) => {
	const f = fixture(t);
	await f.auth.signIn();
	const initial = f.auth.status(), host = f.url.searchParams.get("ext_agent_host_id");
	assert.equal(initial.mode, "chatgpt"); assert.equal(initial.planPermission, true); assert.deepEqual(initial.modelIds, ["gpt-6.1-sol"]);
	assert.equal(statSync(f.file).mode & 0o777, 0o600);
	assert.ok(!readFileSync(f.file).includes(Buffer.from("access-secret")));
	assert.ok(!JSON.stringify(initial).includes("secret"));
	f.reload(); assert.equal((await f.auth.connection()).accessToken, "access-secret");
	await f.auth.signIn(initial.selectedId);
	assert.equal(f.url.searchParams.get("client_id"), "issued-client");
	assert.equal(f.url.searchParams.get("agent_name_hint"), null);
	assert.equal(f.url.searchParams.get("ext_agent_host_id"), host);
	assert.equal(f.auth.status().accounts.length, 1);
});
for (const failure of ["cancel", "decline", "wrongState", "unicodeState"] as const) test(`OAuth ${failure} never exchanges a code or switches authentication`, async (t) => {
	const f = fixture(t); f[failure]();
	await assert.rejects(f.auth.signIn(), /cancelled|declined/);
	assert.equal(f.exchanges, 0); assert.equal(f.auth.status().mode, "api_key"); assert.equal(f.auth.status().pending, false);
});
for (const claim of [{ nonce: "wrong" }, { iss: "https://evil.test" }, { aud: "other-client" }, { exp: 1 }, { sub: "" }]) test(`ID token rejects invalid ${Object.keys(claim)[0]}`, async (t) => {
	const f = fixture(t); f.badClaim(claim); await assert.rejects(f.auth.signIn(), /verification/);
	assert.equal(f.auth.status().authenticated, false);
	assert.equal(f.auth.status().accounts.length, 1, "issued registration is retained for recovery");
});
test("returning sign-in cannot overwrite a different identity", async (t) => {
	const f = fixture(t); await f.auth.signIn(); const before = f.auth.status(); f.account("subject-B");
	await assert.rejects(f.auth.signIn(before.selectedId), /different ChatGPT account/);
	assert.deepEqual(f.auth.status().accounts, before.accounts);
});
test("missing explicit plan grant blocks token access without API fallback", async (t) => {
	const f = fixture(t); f.grant(false); await f.auth.signIn();
	assert.equal(f.auth.status().mode, "chatgpt"); assert.equal(f.auth.status().planPermission, false);
	await assert.rejects(f.auth.connection(), /plan access/);
});
test("concurrent agents share one rotating refresh and persist the replacement", async (t) => {
	const f = fixture(t); await f.auth.signIn(); f.expire();
	const connections = await Promise.all(Array.from({ length: 12 }, () => f.auth.connection()));
	assert.equal(f.refreshes, 1); assert.ok(connections.every((c) => c.accessToken === "access-rotated-1"));
	f.reload(); assert.equal((await f.auth.connection()).accessToken, "access-rotated-1");
});
test("logout racing refresh cannot resurrect credentials; registration and subscription mode survive", async (t) => {
	const f = fixture(t); await f.auth.signIn(); const id = f.auth.status().selectedId; f.expire(); f.holdRefresh();
	const inFlight = f.auth.connection(); const rejection = assert.rejects(inFlight, /connection changed/);
	await f.auth.signOut(); f.release(); await rejection;
	assert.equal(f.revoked, 1); assert.equal(f.auth.status().mode, "chatgpt");
	await assert.rejects(f.auth.connection(), /disconnected/);
	f.reload(); assert.equal(f.auth.status().selectedId, id); await assert.rejects(f.auth.connection(), /disconnected/);
});
test("refresh rejection and unreadable storage fail closed even when API keys could exist", async (t) => {
	const f = fixture(t); await f.auth.signIn(); f.expire(); f.failRefresh();
	await assert.rejects(f.auth.connection(), /expired|rejected/); assert.equal(f.auth.status().mode, "chatgpt");
	writeFileSync(f.file, "corrupt encrypted file"); f.reload();
	await assert.rejects(f.auth.setMode("api_key"), /unlock/);
	await assert.rejects(f.auth.connection(), /unlock/);
});
test("saved account selection isolates registrations and requires explicit API billing selection", async (t) => {
	const f = fixture(t); await f.auth.signIn(); const first = f.auth.status().selectedId;
	f.account("subject-B"); await f.auth.signIn(); const second = f.auth.status().selectedId;
	assert.notEqual(first, second); assert.equal(f.auth.status().accounts.length, 2);
	await f.auth.select(first); await f.auth.signOut(first);
	await assert.rejects(f.auth.connection(), /disconnected/);
	await f.auth.select(second); assert.equal((await f.auth.connection()).mode, "chatgpt");
	await f.auth.setMode("api_key"); assert.deepEqual(await f.auth.connection(), { mode: "api_key" });
});


test("a forged signature never enables model access or touches the existing API-key file", async (t) => {
 const f = fixture(t);
 const apiFile = path.join(path.dirname(f.file), "auth.json");
 writeFileSync(apiFile, JSON.stringify({ OPENAI_API_KEY: "sk-existing-private-key" }));
 const before = readFileSync(apiFile);
 f.corruptSignature();
 await assert.rejects(f.auth.signIn(), /verification/);
 assert.equal(f.auth.status().authenticated, false);
 assert.deepEqual(readFileSync(apiFile), before);
 assert.ok(!JSON.stringify(f.auth.status()).includes("sk-existing-private-key"));
});
