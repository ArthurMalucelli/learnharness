/** Subscription transport boundary. Prompt text, transcript, and tool execution
 * stay with Pi; only the public Responses wire contract is normalized here. */
import { createAssistantMessageEventStream, type AssistantMessage, type StreamFunction } from "@earendil-works/pi-ai";
import { openAIConnection, onChatGPTStatus, type OpenAIConnection } from "./chatgpt-connection.ts";

export function subscriptionPayload(input: unknown): unknown {
	const payload = structuredClone(input) as Record<string, unknown>;
	for (const field of ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]) delete payload[field];
	payload.store = false; payload.stream = true;
	if (!Array.isArray(payload.input)) throw new Error("ChatGPT requires a full conversation transcript.");
	// Preserve tool definitions byte-for-byte as additional_tools, which accepts
	// the same flat function/custom declarations without renaming local tools.
	if (Array.isArray(payload.tools) && payload.tools.length) {
		if (payload.tools.some((t) => !["function", "custom", "namespace"].includes(t.type))) throw new Error("This hosted tool is unavailable with a ChatGPT connection.");
		payload.input.unshift({ type: "additional_tools", role: "developer", tools: payload.tools });
		delete payload.tools;
	}
	for (const item of payload.input) {
		if (item.role === "system") item.role = "developer";
		if (["tool_search_call", "tool_search_output", "configuration_update"].includes(item.type)) throw new Error("This model's request format is unavailable with a ChatGPT connection.");
	}
	return payload;
}

export function withChatGPTConnection(stream: StreamFunction, connection: (signal?: AbortSignal) => Promise<OpenAIConnection> = openAIConnection): StreamFunction {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const controller = new AbortController();
		const cancel = () => controller.abort();
		options?.signal?.addEventListener("abort", cancel, { once: true });
		if (options?.signal?.aborted) cancel();
		let activeAccount: string | undefined;
		const unsubscribe = onChatGPTStatus((status) => {
			if (activeAccount && (status.mode !== "chatgpt" || status.selectedId !== activeAccount || !status.authenticated || !status.planPermission)) cancel();
		});
		void (async () => {
			try {
				const auth = await connection(controller.signal);
				if (controller.signal.aborted) throw new Error("Request was aborted");
				if (auth.mode === "api_key") {
					for await (const event of stream(model, context, options)) output.push(event);
				} else {
					activeAccount = auth.accountId;
					if (auth.modelIds && !auth.modelIds.includes(model.id)) throw new Error("The selected model is unavailable to this ChatGPT account. Choose a model in Settings → Models.");
					if (model.provider !== "openai" || model.api !== "openai-responses" || model.baseUrl !== "https://api.openai.com/v1" || !auth.accessToken || auth.accessToken.startsWith("sk-")) throw new Error("This model is unavailable with the ChatGPT connection. Choose a supported OpenAI model.");
					for await (const event of stream(model, context, {
						...options, signal: controller.signal, apiKey: auth.accessToken, maxRetries: 0,
						onPayload: async (payload, currentModel) => subscriptionPayload(await options?.onPayload?.(payload, currentModel) ?? payload),
						onProviderStreamEvent: async (event, currentModel) => {
							if ((event as { type?: string }).type === "response.incomplete") throw new Error("ChatGPT response was incomplete. Try again.");
							await options?.onProviderStreamEvent?.(event, currentModel);
						},
					})) output.push(event);
				}
			} catch (error) {
				const stopReason = controller.signal.aborted ? "aborted" : "error";
				const failure: AssistantMessage = {
					role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
					stopReason, errorMessage: error instanceof Error ? error.message : "ChatGPT connection failed.", timestamp: Date.now(),
					usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				output.push({ type: "error", reason: stopReason, error: failure });
			} finally { unsubscribe(); options?.signal?.removeEventListener("abort", cancel); output.end(); }
		})();
		return output;
	};
}
