/** Desktop-only Sign in with ChatGPT. No credentials cross the renderer bridge.
 * Protocol: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * Independently implemented; no DevKit source or dependencies are included. */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const USAGE_URL = "https://chatgpt.com/settings/usage";
class AuthError extends Error {
	constructor(message, status) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new AuthError(message, status); };
const random = () => crypto.randomBytes(32).toString("base64url");
const equal = (a, b) => {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const left = Buffer.from(a), right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function createChatGPTAuth({ file, safeStorage, openExternal, fetch: fetcher = fetch, now = Date.now, loginTimeoutMs = 300000 }) {
	let state = { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, mode: "api_key", selectedId: null, accounts: [] };
	let locked = false;
	let pending = null;
	let message = null;
	const listeners = new Set();
	const refreshes = new Map();
	const catalogs = new Map();
	let discoveryPromise;

	function save() {
		if (locked || !safeStorage.isEncryptionAvailable()) fail("Secure credential storage is unavailable. Unlock your login keychain and restart LearnHarness.");
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const encrypted = safeStorage.encryptString(JSON.stringify(state));
		const temp = `${file}.${crypto.randomUUID()}.tmp`;
		try {
			const fd = fs.openSync(temp, "wx", 0o600);
			try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			fs.renameSync(temp, file);
			fs.chmodSync(file, 0o600);
		} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	}
	try {
		if (fs.existsSync(file)) {
			if (!safeStorage.isEncryptionAvailable()) throw new Error();
			const loaded = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
			if (loaded.version !== 1 || !Array.isArray(loaded.accounts) || !["chatgpt", "api_key"].includes(loaded.mode) || !loaded.hostId) throw new Error();
			state = loaded;
		}
	} catch {
		// Never treat an unreadable subscription store as permission for API billing.
		locked = true;
		state.mode = "chatgpt";
		message = "Could not unlock ChatGPT credentials. Unlock your login keychain and restart LearnHarness.";
	}
	const selected = () => state.accounts.find((a) => a.id === state.selectedId);
	const permitted = (a) => !!a?.scopes?.includes(PLAN_SCOPE) && !!a?.scopes?.includes("resource.invoke");
	function status() {
		const a = selected();
		return {
			desktop: true, mode: state.mode, selectedId: state.selectedId,
			authenticated: !locked && !a?.invalid && !!a?.accessToken && (a.expiresAt > now() || !!a.refreshToken),
			planPermission: permitted(a), pending: !!pending, message,
			accounts: state.accounts.map((p) => ({ id: p.id, label: p.email || p.name || "ChatGPT account", connected: !!p.accessToken })),
			modelIds: catalogs.get(a?.id)?.ids ?? [],
			modelNames: catalogs.get(a?.id)?.names ?? {},
		};
	}
	function changed() { const value = status(); for (const listener of listeners) listener(value); }
	async function json(url, options = {}) {
		let response;
		try { response = await fetcher(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(20000) }); }
		catch { fail("Could not reach OpenAI. Check your connection and try again."); }
		if (!response.ok) {
			if (response.status === 401 || response.status === 400) fail("ChatGPT authorization expired or was rejected. Reconnect your account.", response.status);
			if (response.status === 403) fail("This account has not granted access to its ChatGPT plan. Reconnect and allow plan access.", response.status);
			if (response.status === 429) fail("ChatGPT usage limit reached. Open Manage usage or try again later.");
			fail("OpenAI is unavailable. Try again later.");
		}
		try { return await response.json(); } catch { fail("OpenAI returned an invalid authentication response."); }
	}
	async function discovery() {
		if (!discoveryPromise) discoveryPromise = json(`${ISSUER}/.well-known/openid-configuration`).then((d) => {
			if (d.issuer !== ISSUER) fail("OpenAI identity issuer could not be verified.");
			for (const endpoint of [d.jwks_uri, d.revocation_endpoint].filter(Boolean)) {
				if (new URL(endpoint).origin !== ISSUER) fail("OpenAI identity endpoint could not be verified.");
			}
			return d;
		}).catch((error) => { discoveryPromise = undefined; throw error; });
		return discoveryPromise;
	}
	async function verifyIdToken(jwt, clientId, nonce, previous) {
		try {
			if (typeof jwt !== "string" || jwt.length > 32768) throw new Error();
			const parts = jwt.split(".");
			if (parts.length !== 3) throw new Error();
			const header = JSON.parse(Buffer.from(parts[0], "base64url"));
			const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
			if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error();
			const d = await discovery();
			const jwks = await json(d.jwks_uri);
			const key = jwks.keys?.find((k) => k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig") && (!k.alg || k.alg === "RS256"));
			if (!key || !crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error();
			const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
			if (claims.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) throw new Error();
			if (typeof claims.exp !== "number" || claims.exp <= now() / 1000 || typeof claims.iat !== "number" || claims.iat > now() / 1000 + 60 || (claims.nbf && claims.nbf > now() / 1000 + 60)) throw new Error();
			if (typeof claims.sub !== "string" || !claims.sub || (nonce !== undefined && !equal(claims.nonce, nonce))) throw new Error();
			if (previous?.sub && (previous.sub !== claims.sub || previous.issuer !== claims.iss)) fail("A different ChatGPT account signed in. Use Add account instead.");
			return claims;
		} catch (error) {
			if (error instanceof AuthError) throw error;
			fail("ChatGPT identity verification failed. Reconnect your account.");
		}
	}
	function tokenValues(body, previous) {
		if (typeof body.access_token !== "string" || !body.access_token || body.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) fail("OpenAI returned an invalid token response.");
		if (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || !body.refresh_token)) fail("OpenAI returned an invalid refresh token.");
		return {
			accessToken: body.access_token, refreshToken: body.refresh_token ?? previous?.refreshToken,
			idToken: body.id_token ?? previous?.idToken, expiresAt: now() + body.expires_in * 1000,
			// OAuth permits refresh responses to omit an unchanged scope.
			scopes: typeof body.scope === "string" ? body.scope.split(/\s+/) : previous?.scopes ?? [],
		};
	}
	async function postToken(params, signal) {
		return json(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal });
	}
	function cancel() { pending?.abort(); }
	async function signIn(accountId) {
		if (locked) fail(message);
		if (pending) fail("A ChatGPT sign-in is already in progress.");
		let account = accountId ? state.accounts.find((a) => a.id === accountId) : undefined;
		if (accountId && !account) fail("Unknown ChatGPT account.");
		// Retain an issued registration whose exchange was interrupted.
		account ??= !accountId ? state.accounts.find((a) => !a.sub && !a.accessToken) : undefined;
		save(); // Persist host ID before opening any browser.
		const verifier = random(), stateValue = random(), nonce = random();
		const controller = new AbortController();
		let finish, rejectCallback, timer;
		const callback = new Promise((resolve, reject) => { finish = resolve; rejectCallback = reject; });
		// Observe early cancellations while browser launch is still resolving.
		callback.catch(() => {});
		pending = { abort: () => { controller.abort(new AuthError("ChatGPT sign-in cancelled.")); rejectCallback(controller.signal.reason); } };
		message = null;
		changed();
		const server = http.createServer((req, res) => {
			const url = new URL(req.url, "http://127.0.0.1");
			if (req.method !== "GET" || url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.setHeader("Cache-Control", "no-store");
			if (url.searchParams.getAll("state").length !== 1 || !equal(url.searchParams.get("state"), stateValue)) { res.writeHead(400).end("Invalid sign-in state."); return; }
			if (url.searchParams.has("error")) { res.end("Sign-in was not completed. Return to LearnHarness."); rejectCallback(new AuthError("ChatGPT sign-in was declined or cancelled.")); return; }
			const code = url.searchParams.get("code");
			const issuedClient = url.searchParams.get("client_id") ?? account?.clientId;
			if (!code || issuedClient === "dynamic_agent_client" || issuedClient?.length > 200 || url.searchParams.getAll("code").length !== 1 || !issuedClient || url.searchParams.getAll("client_id").length > 1 || (account && account.clientId !== issuedClient)) { res.writeHead(400).end("Invalid sign-in callback."); rejectCallback(new AuthError("ChatGPT sign-in callback could not be verified.")); return; }
			res.end("Sign-in received. Return to LearnHarness to finish connecting.");
			finish({ code, clientId: issuedClient });
		});
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
			const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
			const url = new URL(AUTHORIZE);
			url.search = new URLSearchParams({ response_type: "code", client_id: account?.clientId ?? "dynamic_agent_client", redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state: stateValue, nonce, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ext_agent_host_id: state.hostId }).toString();
			if (!account) url.searchParams.set("agent_name_hint", "LearnHarness");
			if (account?.idToken) url.searchParams.set("id_token_hint", account.idToken);
			timer = setTimeout(() => { controller.abort(new AuthError("ChatGPT sign-in timed out. Try again.")); rejectCallback(controller.signal.reason); }, loginTimeoutMs);
			await openExternal(url.toString());
			const result = await callback;
			if (controller.signal.aborted) fail("ChatGPT sign-in cancelled.");
			if (!account) {
				account = { id: crypto.randomUUID(), clientId: result.clientId };
				state.accounts.push(account);
				save(); // Issued client ID survives a failed exchange.
			}
			const body = await postToken({ grant_type: "authorization_code", client_id: account.clientId, redirect_uri: redirectUri, code: result.code, code_verifier: verifier, resource: RESOURCE }, controller.signal);
			const claims = await verifyIdToken(body.id_token, account.clientId, nonce, account);
			if (controller.signal.aborted) fail("ChatGPT sign-in cancelled.");
			Object.assign(account, tokenValues(body), { invalid: false, sub: claims.sub, issuer: claims.iss, email: claims.email, name: claims.name });
			state.selectedId = account.id;
			state.mode = "chatgpt";
			message = permitted(account) ? null : "Signed in, but ChatGPT plan access was not granted. Reconnect and allow plan access.";
			catalogs.delete(account.id);
			save();
		} catch (error) {
			message = controller.signal.aborted ? controller.signal.reason.message : error instanceof AuthError ? error.message : "ChatGPT sign-in failed. Try again.";
			throw new AuthError(message);
		} finally {
			clearTimeout(timer);
			server.close();
			server.closeAllConnections();
			pending = null;
			changed();
		}
		await models();
		return status();
	}
	async function accessToken(account = selected()) {
		if (locked || account?.invalid || !account?.accessToken) fail("ChatGPT is disconnected. Reconnect in provider settings.");
		if (!permitted(account)) fail("ChatGPT plan access was not granted. Reconnect and allow plan access.");
		if (account.expiresAt > now() + 60000) return account.accessToken;
		if (!account.refreshToken) fail("ChatGPT authorization expired. Reconnect in provider settings.");
		if (!refreshes.has(account.id)) {
			const refreshToken = account.refreshToken;
			const refreshing = (async () => {
				const body = await postToken({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: refreshToken, resource: RESOURCE });
				if (body.id_token) await verifyIdToken(body.id_token, account.clientId, undefined, account);
				if (account.refreshToken !== refreshToken) fail("ChatGPT connection changed. Try again.");
				Object.assign(account, tokenValues(body, account));
				save();
				changed();
				if (!permitted(account)) fail("ChatGPT plan permission was removed. Reconnect your account.");
				return account.accessToken;
			})().catch((error) => {
				if ([400, 401, 403].includes(error.status) && account.refreshToken === refreshToken) { account.invalid = true; catalogs.delete(account.id); save(); }
				message = error instanceof AuthError ? error.message : "ChatGPT refresh failed. Reconnect your account.";
				changed();
				throw new AuthError(message);
			}).finally(() => refreshes.delete(account.id));
			refreshes.set(account.id, refreshing);
		}
		return refreshes.get(account.id);
	}
	async function models() {
		const account = selected();
		if (state.mode !== "chatgpt" || !account?.accessToken || !permitted(account)) return status();
		const cached = catalogs.get(account.id);
		if (cached?.expiresAt > now()) return status();
		try {
			const access = await accessToken(account);
			const body = await json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${access}` } });
			if (!Array.isArray(body.models)) fail("OpenAI returned an invalid subscription model catalog.");
			const listed = body.models.filter((m) => m.visibility === "list" && typeof m.slug === "string");
			const ids = listed.map((m) => m.slug);
			const names = Object.fromEntries(listed.filter((m) => typeof m.display_name === "string").map((m) => [m.slug, m.display_name]));
			if (account.accessToken === access) catalogs.set(account.id, { ids, names, expiresAt: now() + 300000 });
			message = ids.length ? null : "No subscription models are available to this account.";
		} catch (error) { message = error instanceof AuthError ? error.message : "Could not load ChatGPT models. Try again."; catalogs.delete(account.id); }
		changed();
		return status();
	}
	async function connection() {
		if (locked) fail(message);
		if (state.mode !== "chatgpt") return { mode: "api_key" };
		const id = state.selectedId;
		const access = await accessToken();
		await models();
		if (!catalogs.has(id)) fail(message ?? "ChatGPT models are unavailable. Reconnect your account.");
		if (state.mode !== "chatgpt" || state.selectedId !== id) fail("ChatGPT connection changed. Try again.");
		return { mode: "chatgpt", accessToken: access, accountId: id, modelIds: catalogs.get(id).ids };
	}
	async function signOut(id = state.selectedId) {
		cancel();
		const account = state.accounts.find((a) => a.id === id);
		if (!account) fail("Unknown ChatGPT account.");
		const refresh = account.refreshToken;
		delete account.accessToken; delete account.refreshToken; delete account.idToken; delete account.scopes; delete account.expiresAt;
		catalogs.delete(id);
		save(); changed(); // Clear locally first; mode stays chatgpt, even offline.
		message = null;
		if (refresh) {
			try {
				const d = await discovery();
				if (!d.revocation_endpoint) throw new Error();
				const res = await fetcher(d.revocation_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh, token_type_hint: "refresh_token", client_id: account.clientId }) });
				if (!res.ok) throw new Error();
			} catch { message = "Signed out locally. Remote revocation could not be confirmed; manage connected apps in ChatGPT."; }
		}
		changed(); return status();
	}
	return {
		status, signIn, cancel, signOut, models, connection,
		onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		async select(id) { if (locked) fail(message); cancel(); if (!state.accounts.some((a) => a.id === id)) fail("Unknown ChatGPT account."); state.selectedId = id; state.mode = "chatgpt"; message = null; save(); changed(); return models(); },
		async setMode(mode) { if (locked) fail(message); if (!["chatgpt", "api_key"].includes(mode)) fail("Unknown OpenAI authentication method."); cancel(); state.mode = mode; message = null; save(); changed(); return models(); },
	};
}
module.exports = { createChatGPTAuth, AuthError, USAGE_URL };
