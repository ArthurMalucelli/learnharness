import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../src/agent/models.ts";
import { subscriptionPayload, withChatGPTConnection } from "../src/agent/chatgpt-stream.ts";
const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "off" });
const context = normalizeContext({ messages: [
	{ role: "system", content: "Unchanged teaching instructions.", toolsAdded: [{ name: "practice_check", description: "Check the answer", parameters: Type.Object({ answer: Type.String() }) }], timestamp: 1 },
	{ role: "user", content: [{ type: "text", text: "Read the diagram." }, { type: "image", data: "AQID", mimeType: "image/png" }], timestamp: 2 },
] });
function sse(terminal = "response.completed", call = false) {
	const item = call ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "practice_check", arguments: '{"answer":"42"}', status: "completed" } : { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Fixture answer", annotations: [] }], status: "completed" };
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, ...(call ? { arguments: "" } : { content: [] }) } },
		call ? { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"answer":"42"}' } : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Fixture answer" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: terminal, response: { id: "resp_1", status: terminal.slice(9), output: [item], error: terminal === "response.failed" ? { code: "subscription_sharing_usage_limit_exceeded", message: "Plan limit reached" } : undefined, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
	];
	return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
test("real Pi transport: subscription bearer, unchanged prompts, images, tools, streaming and full resumed history", async () => {
	const before = JSON.stringify(context);
	const requests: Record<string, unknown>[] = [];
	let credentials = 0;
	const stream = withChatGPTConnection(engine.streamFn, async () => ({ mode: "chatgpt", accessToken: `oauth-fixture-${++credentials}` }));
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://api.openai.com/v1/responses");
		assert.equal(request.headers.get("Authorization"), `Bearer oauth-fixture-${credentials}`);
		const payload = await request.json(); requests.push(payload);
		assert.equal(payload.store, false); assert.equal(payload.stream, true); assert.ok(Array.isArray(payload.input));
		for (const key of ["temperature", "top_p", "max_output_tokens", "previous_response_id", "prompt_cache_retention"]) assert.equal(payload[key], undefined);
		assert.match(JSON.stringify(payload), /Unchanged teaching instructions\./);
		assert.match(JSON.stringify(payload), /data:image\/png;base64,AQID/);
		assert.match(JSON.stringify(payload), /additional_tools/);
		assert.ok(!payload.input.some((i: { role?: string }) => i.role === "system"));
		return sse("response.completed", requests.length === 1);
	};
	const firstStream = stream(engine.model, context, { fetch: fetcher, temperature: 0.3, maxTokens: 64 });
	const types: string[] = [];
	for await (const event of firstStream) types.push(event.type);
	const first = await firstStream.result();
	assert.equal(first.stopReason, "toolUse"); assert.ok(types.includes("toolcall_delta"));
	const tool = first.content.find((c) => c.type === "toolCall")!;
	const resumed: TranscriptContext = normalizeContext({ messages: [...context.messages, first, { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "Correct answer" }], isError: false, timestamp: 3 }] });
	const final = await stream(engine.model, resumed, { fetch: fetcher }).result();
	assert.equal(final.stopReason, "stop"); assert.equal(final.usage.totalTokens, 30);
	assert.equal(credentials, 2); assert.equal(JSON.stringify(context), before);
	assert.match(JSON.stringify(requests[1]), /function_call_output/); assert.match(JSON.stringify(requests[1]), /Correct answer/);
});
for (const terminal of ["response.failed", "response.incomplete"]) test(`${terminal} remains failure without fallback or retries`, async () => {
	let requests = 0;
	const stream = withChatGPTConnection(engine.streamFn, async () => ({ mode: "chatgpt", accessToken: "oauth-fixture" }));
	const final = await stream(engine.model, context, { apiKey: "sk-must-never-be-used", fetch: async (_url, options) => { requests++; assert.match(String(new Headers(options?.headers).get("authorization")), /oauth-fixture/); return sse(terminal); } }).result();
	assert.equal(final.stopReason, "error"); assert.equal(requests, 1);
});
test("disconnected, refresh failure, invalid token, and cancellation never reach API billing", async () => {
	let requests = 0;
	const fetcher: typeof fetch = async () => { requests++; return sse(); };
	for (const get of [async () => { throw new Error("Reconnect ChatGPT"); }, async () => ({ mode: "chatgpt" as const, accessToken: "" }), async () => ({ mode: "chatgpt" as const, accessToken: "sk-not-subscription" })]) {
		const final = await withChatGPTConnection(engine.streamFn, get)(engine.model, context, { apiKey: "sk-configured", fetch: fetcher }).result();
		assert.equal(final.stopReason, "error");
	}
	const controller = new AbortController(); controller.abort();
	const final = await withChatGPTConnection(engine.streamFn, async () => ({ mode: "chatgpt", accessToken: "oauth" }))(engine.model, context, { signal: controller.signal, fetch: fetcher }).result();
	assert.equal(final.stopReason, "aborted"); assert.equal(requests, 0);
});
test("HTTP usage limit is not retried with either token or configured API key", async () => {
	let requests = 0;
	const final = await withChatGPTConnection(engine.streamFn, async () => ({ mode: "chatgpt", accessToken: "oauth" }))(engine.model, context, { apiKey: "sk-must-not-leak", fetch: async () => { requests++; return Response.json({ error: { message: "subscription_sharing_usage_limit_exceeded" } }, { status: 429 }); } }).result();
	assert.equal(final.stopReason, "error"); assert.equal(requests, 1); assert.match(final.errorMessage!, /chatgpt.com\/settings\/usage/);
});
test("normalization never mutates prompts or tool definitions", () => {
	const payload = { input: [{ role: "system", content: "Exact text" }], tools: [{ type: "function", name: "check", parameters: { type: "object" } }], metadata: { remove: true } };
	const before = JSON.stringify(payload);
	const adapted = subscriptionPayload(payload) as typeof payload;
	assert.equal(JSON.stringify(payload), before); assert.equal(adapted.input[1]!.content, "Exact text");
});
