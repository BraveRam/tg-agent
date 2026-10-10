import { test } from "node:test";
import assert from "node:assert/strict";

import { streamText, tool } from "ai";
import { z } from "zod";

import { mainModelConfig, isFreeNvidiaModel, isSubscriptionModel } from "../agent/lib/main-model";

test("provider selection validates credentials and uses provider-appropriate compaction thresholds", () => {
  const vercel = mainModelConfig({ AI_GATEWAY_API_KEY: "test-gateway" });
  const nvidia = mainModelConfig({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "test-nvidia" });
  const subscription = mainModelConfig({ MODEL_PROVIDER: "chatgpt" });

  assert.equal(vercel.model.provider, "gateway");
  assert.equal(vercel.model.modelId, "openai/gpt-6-luna");
  assert.equal(nvidia.model.provider, "nvidia.chat");
  assert.equal(nvidia.model.modelId, "meta/muse-glimmer-30b");

  assert.equal(subscription.model.provider, "codex.responses");
  assert.equal(subscription.model.modelId, "gpt-6.1-sol");
  assert.equal(subscription.reasoning, "medium");
  assert.equal(isSubscriptionModel(subscription.model), true);
  assert.equal(isSubscriptionModel(vercel.model), false);

  for (const config of [vercel, nvidia, subscription])
    assert.equal(
      Math.floor(config.modelContextWindowTokens * config.compaction.thresholdPercent),
      config === nvidia ? Math.floor(131_072 * (230_000 / 1_050_000)) : 230_000,
    );

  assert.throws(() => mainModelConfig({ MODEL_PROVIDER: "other" }), /MODEL_PROVIDER/);
  assert.throws(() => mainModelConfig({ MODEL_PROVIDER: "nvidia" }), /NVIDIA_API_KEY/);
  assert.equal(isFreeNvidiaModel(nvidia.model), true);
  assert.equal(isFreeNvidiaModel({ provider: "gateway", modelId: nvidia.model.modelId }), false);
  assert.equal(isFreeNvidiaModel({ provider: "nvidia.chat", modelId: "other" }), false);
});

test("NVIDIA streams tool calls and usage through its own endpoint with the configured key", async () => {
  const previousFetch = globalThis.fetch;
  let request: any;
  let headers: Headers | undefined;
  let url: string | undefined;
  const chunk = (choices: unknown[], usage?: unknown) => ({
    id: "response-one",
    object: "chat.completion.chunk",
    created: 1,
    model: "meta/muse-glimmer-30b",
    choices,
    ...(usage ? { usage } : {}),
  });
  const chunks = [
    chunk([
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-one",
              type: "function",
              function: { name: "inspect", arguments: '{"value":' },
            },
          ],
        },
        finish_reason: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "7}" } }] },
        finish_reason: null,
      },
    ]),
    chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
    chunk([], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
  ];

  globalThis.fetch = (async (input: any, init: any) => {
    url = String(input);
    headers = new Headers(init.headers);
    request = JSON.parse(init.body);

    return new Response(
      chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  }) as typeof fetch;

  try {
    const config = mainModelConfig({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "test-nvidia" });
    const result = streamText({
      model: config.model,
      reasoning: config.reasoning,
      prompt: "Inspect the number seven.",
      tools: { inspect: tool({ inputSchema: z.object({ value: z.number() }) }) },
      toolChoice: "required",
      maxRetries: 0,
    });

    assert.deepEqual((await result.toolCalls)[0].input, { value: 7 });
    assert.equal((await result.usage).inputTokens, 10);
    assert.equal((await result.usage).outputTokens, 5);
    assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(headers?.get("authorization"), "Bearer test-nvidia");
    assert.equal(request.model, "meta/muse-glimmer-30b");
    assert.equal(request.reasoning_effort, "low");
    assert.equal(request.stream, true);
    assert.equal(request.stream_options.include_usage, true);
    assert.equal(request.temperature, 1);
    assert.equal(request.top_p, 0.95);
    assert.equal(request.tools[0].function.name, "inspect");
    assert.equal(request.tool_choice, "required");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
