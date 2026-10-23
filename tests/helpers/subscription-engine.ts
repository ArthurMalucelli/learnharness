/** Opt-in rerun of existing domain fixtures through the subscription boundary.
 * Faux responses and their stamps remain unchanged; only credentials are synthetic.
 * Run LH_TEST_CHATGPT_BOUNDARY=1 with chat-flow, practice-flow and extraction. */
import assert from "node:assert/strict";
import { piModels, type PiEngine } from "../../src/agent/models.ts";
import { withChatGPTConnection } from "../../src/agent/chatgpt-stream.ts";
export function subscriptionFixture(engine: PiEngine): PiEngine {
	if (process.env.LH_TEST_CHATGPT_BOUNDARY !== "1") return engine;
	const model = piModels().getModel("openai", "gpt-4o-mini")!;
	const stream = withChatGPTConnection((_model, context, options) => {
		assert.equal(options?.apiKey, "fixture-subscription-token");
		assert.equal(options.maxRetries, 0);
		return engine.streamFn(engine.model, context, options);
	}, async () => ({ mode: "chatgpt", accessToken: "fixture-subscription-token" }));
	return { ...engine, streamFn: (_model, context, options) => stream(model, context, options) };
}
