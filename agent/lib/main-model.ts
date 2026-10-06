import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";

type Env = Record<string, string | undefined>;

export const nvidiaModelId = "meta/muse-glimmer-30b";

export function mainModelProvider(env: Env = process.env) {
  const provider = env.MODEL_PROVIDER ?? "vercel";

  if (provider !== "vercel" && provider !== "nvidia")
    throw new Error("MODEL_PROVIDER must be vercel or nvidia");

  return provider;
}

export function mainModelConfig(env: Env = process.env) {
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
      : createGateway({ apiKey: env.AI_GATEWAY_API_KEY })("openai/gpt-6-luna");

  return {
    // Both branches use runtime model handles so changing .env works after restart.
    model,
    reasoning: "low" as const,
    modelContextWindowTokens: contextWindow,
    compaction: { thresholdPercent: 100_000 / contextWindow },
  };
}

export function isFreeNvidiaModel(model: { provider: string; modelId: string } | null) {
  return model?.provider === "nvidia.chat" && model.modelId === nvidiaModelId;
}
