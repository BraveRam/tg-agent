import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { chatgpt } from "eve/models/openai";

type Env = Record<string, string | undefined>;

export const nvidiaModelId = "meta/muse-glimmer-30b";
export const modelChoices = [
  { id: "luna", label: "GPT-6 Luna · ChatGPT", provider: "chatgpt", modelId: "gpt-6-luna" },
  { id: "sol", label: "GPT-6.1 Sol · ChatGPT", provider: "chatgpt", modelId: "gpt-6.1-sol" },
  { id: "nvidia", label: "Muse Glimmer · NVIDIA", provider: "nvidia", modelId: nvidiaModelId },
  { id: "vercel", label: "GPT-6 Luna · Vercel", provider: "vercel", modelId: "openai/gpt-6-luna" },
] as const;
export const modelSelectionKey = "agent.modelSelection";

export function mainModelProvider(env: Env = process.env) {
  const provider = env.MODEL_PROVIDER ?? "vercel";

  if (provider !== "vercel" && provider !== "nvidia" && provider !== "chatgpt")
    throw new Error("MODEL_PROVIDER must be vercel, nvidia or chatgpt");

  return provider;
}

export function mainModelConfig(env: Env = process.env, chatgptModel = "gpt-6.1-sol") {
  const provider = mainModelProvider(env);
  // NVIDIA documents a 131,072-token combined input/output window for Muse Glimmer.
  const contextWindow = provider === "nvidia" ? 131_072 : 1_050_000;

  if (provider === "nvidia" && !env.NVIDIA_API_KEY)
    throw new Error("NVIDIA_API_KEY is required when MODEL_PROVIDER=nvidia");

  const model =
    provider === "nvidia"
      ? createOpenAICompatible({
          name: "nvidia",
          baseURL: "https://integrate.api.nvidia.com/v1",
          apiKey: env.NVIDIA_API_KEY,
          includeUsage: true,
          transformRequestBody: (body) => ({
            ...body,
            temperature: 1,
            top_p: 0.95,
            max_tokens: body.max_tokens ?? 8192,
          }),
        })(nvidiaModelId)
      : provider === "chatgpt"
        ? chatgpt(chatgptModel)
        : createGateway({ apiKey: env.AI_GATEWAY_API_KEY })("openai/gpt-6-luna");

  if (typeof model === "string") throw new Error("Expected a runtime model handle");

  return {
    // Runtime model handles let the provider change after a restart.
    model,
    reasoning:
      provider === "chatgpt" && chatgptModel === "gpt-6.1-sol"
        ? ("medium" as const)
        : ("low" as const),
    modelContextWindowTokens: contextWindow,
    compaction: { thresholdPercent: 230_000 / 1_050_000 },
  };
}

export function isSubscriptionModel(model: { provider: string; modelId: string } | null) {
  return (
    model?.provider === "codex.responses" && ["gpt-6.1-sol", "gpt-6-luna"].includes(model.modelId)
  );
}

export function isFreeNvidiaModel(model: { provider: string; modelId: string } | null) {
  return model?.provider === "nvidia.chat" && model.modelId === nvidiaModelId;
}
