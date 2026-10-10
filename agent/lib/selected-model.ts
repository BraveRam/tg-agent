import { mainModelConfig, modelChoices, modelSelectionKey } from "./main-model";
import { store, type Store } from "./store";

type Env = Record<string, string | undefined>;

export function selectedModelConfig(s: Store = store(), env: Env = process.env) {
  const selected = s.get<string | null>(modelSelectionKey, null);
  const choice = modelChoices.find((item) => item.id === selected);
  return mainModelConfig(
    choice ? { ...env, MODEL_PROVIDER: choice.provider } : env,
    choice?.provider === "chatgpt" ? choice.modelId : "gpt-6.1-sol",
  );
}
