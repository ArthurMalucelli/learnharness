/** Private IPC to the Electron parent. No HTTP credential endpoint or env tokens.
 * globalThis keeps one listener across Next server chunks / development reloads. */
import { randomUUID } from "node:crypto";
import type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
const CHANNEL = "lh:chatgpt";
export const desktopChatGPT = () => process.env.LH_CHATGPT_DESKTOP === "1";
export type OpenAIConnection = { mode: "api_key" } | { mode: "chatgpt"; accessToken: string; accountId?: string; modelIds?: string[] };
const empty = (): ChatGPTStatus => ({ desktop: desktopChatGPT(), mode: desktopChatGPT() && process.env.LH_OPENAI_AUTH_MODE !== "api_key" ? "chatgpt" : "api_key", selectedId: null, authenticated: desktopChatGPT() && process.env.LH_CHATGPT_AVAILABLE === "true", planPermission: desktopChatGPT() && process.env.LH_CHATGPT_AVAILABLE === "true", pending: false, message: null, accounts: [], modelIds: [] });
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const globalState = globalThis as typeof globalThis & { __lhChatGPT?: { status: ChatGPTStatus; requests: Map<string, Pending>; listeners: Set<(status: ChatGPTStatus) => void> } };
function state() {
	if (!globalState.__lhChatGPT) {
		const shared = { status: empty(), requests: new Map<string, Pending>(), listeners: new Set<(status: ChatGPTStatus) => void>() };
		globalState.__lhChatGPT = shared;
		if (desktopChatGPT()) {
			process.on("message", (input: unknown) => {
				const msg = input as { channel?: string; event?: string; status?: ChatGPTStatus; id?: string; error?: string; value?: unknown };
				if (msg?.channel !== CHANNEL) return;
				if (msg.event === "status" && msg.status) {
					shared.status = msg.status;
					for (const listener of shared.listeners) listener(msg.status);
				}
				if (msg.id) {
					const pending = shared.requests.get(msg.id);
					if (msg.error) pending?.reject(new Error(msg.error));
					else pending?.resolve(msg.value);
				}
			});
			process.on("disconnect", () => {
				shared.status = { ...shared.status, authenticated: false, modelIds: [], message: "Desktop connection closed. Restart LearnHarness." };
				for (const listener of shared.listeners) listener(shared.status);
				for (const request of shared.requests.values()) request.reject(new Error(shared.status.message!));
			});
		}
	}
	return globalState.__lhChatGPT;
}
function request<T>(operation: "connection" | "status" | "models", signal?: AbortSignal): Promise<T> {
	const shared = state();
	return new Promise((resolve, reject) => {
		if (!process.send || !process.connected) { reject(new Error("Desktop ChatGPT connection is unavailable. Restart LearnHarness.")); return; }
		const id = randomUUID();
		const finish = (error?: Error, value?: unknown) => {
			clearTimeout(timer); signal?.removeEventListener("abort", abort); shared.requests.delete(id);
			if (error) reject(error); else resolve(value as T);
		};
		const abort = () => finish(new Error("Request was aborted"));
		const timer = setTimeout(() => finish(new Error("ChatGPT connection timed out. Try again.")), 60000);
		shared.requests.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) { abort(); return; }
		process.send({ channel: CHANNEL, id, operation }, (error) => { if (error) finish(new Error("Desktop ChatGPT connection closed.")); });
	});
}
export function chatGPTStatus(): ChatGPTStatus { return state().status; }
export async function refreshChatGPTStatus(withModels = false): Promise<ChatGPTStatus> {
	if (!desktopChatGPT()) return state().status;
	try { state().status = await request<ChatGPTStatus>(withModels ? "models" : "status"); }
	catch { state().status = { ...state().status, authenticated: false, modelIds: [], message: "Desktop connection unavailable. Restart LearnHarness." }; }
	return state().status;
}
export async function openAIConnection(signal?: AbortSignal): Promise<OpenAIConnection> {
	if (!desktopChatGPT()) return { mode: "api_key" };
	// Always ask the parent. A stale cache, logout, or lost IPC cannot enable BYOK.
	return request<OpenAIConnection>("connection", signal);
}

export function onChatGPTStatus(listener: (status: ChatGPTStatus) => void): () => void {
	state().listeners.add(listener);
	return () => { state().listeners.delete(listener); };
}
