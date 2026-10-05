import data from "./bot-schema";

interface Field {
  type: string;
  required: boolean;
  description: string;
  literal?: string;
}

interface Definition {
  fields?: Record<string, Field>;
  variants?: string[];
}

const methods = data.methods as Record<string, Definition>;

const types = data.types as Record<string, Definition>;

export function telegramMethod(method: string) {
  return Object.hasOwn(methods, method) ? methods[method] : undefined;
}

export function describeTelegramMethod(method: string) {
  const definition = telegramMethod(method);

  if (!definition)
    throw new Error("Unknown Bot API method; consult https://core.telegram.org/bots/api");

  const definitions: Record<string, Definition> = {};

  function include(kind: string) {
    for (const name of kind.match(/[A-Z][A-Za-z0-9]+/g) ?? []) {
      if (!Object.hasOwn(types, name) || Object.hasOwn(definitions, name)) continue;

      definitions[name] = types[name];
      Object.values(types[name].fields ?? {}).forEach((field) => include(field.type));
      types[name].variants?.forEach(include);
    }
  }

  Object.values(definition.fields ?? {}).forEach((field) => include(field.type));

  return {
    method,
    source: `${data.source}#${method.toLowerCase()}`,
    retrieved: data.retrieved,
    parameters: definition.fields ?? {},
    definitions,
    ...(method === "sendPoll"
      ? {
          example: {
            question: "Which organelle is the powerhouse of the cell?",
            options: [{ text: "Ribosome" }, { text: "Mitochondrion" }],
            type: "quiz",
            correct_option_ids: [1],
          },
        }
      : {}),
  };
}

export function telegramParameterErrors(method: string, params: Record<string, unknown>): string[] {
  const errors: string[] = [];

  function valueErrors(value: unknown, kind: string, path: string, depth: number): string[] {
    if (depth > 30) return [`${path}: nesting exceeds 30 levels`];

    if (kind.startsWith("Array of ")) {
      if (!Array.isArray(value)) return [`${path}: expected ${kind}`];

      return value.flatMap((item, index) =>
        valueErrors(item, kind.slice(9), `${path}[${index}]`, depth + 1),
      );
    }

    const alternatives = kind.split(/,\s*|\s+(?:or|and)\s+/);

    if (alternatives.length > 1) {
      const discriminator =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).type
          : undefined;
      const selected = alternatives.find(
        (name) =>
          types[name]?.fields?.type?.literal === discriminator && discriminator !== undefined,
      );

      if (selected) return valueErrors(value, selected, path, depth + 1);

      const candidates = alternatives.map((alternative) =>
        valueErrors(value, alternative, path, depth + 1),
      );

      return candidates.some((candidate) => !candidate.length) ? [] : [`${path}: expected ${kind}`];
    }

    if (kind === "String" || kind === "InputFile")
      return typeof value === "string" ? [] : [`${path}: expected ${kind} string`];

    if (kind === "Integer")
      return typeof value === "number" && Number.isSafeInteger(value)
        ? []
        : [`${path}: expected Integer`];

    if (kind === "Float" || kind === "Float number")
      return typeof value === "number" && Number.isFinite(value)
        ? []
        : [`${path}: expected finite number`];

    if (kind === "Boolean" || kind === "True")
      return typeof value === "boolean" && (kind !== "True" || value === true)
        ? []
        : [`${path}: expected ${kind}`];

    const definition = types[kind];

    if (!definition)
      return [`${path}: unsupported schema type ${kind}; consult official documentation`];

    if (definition.variants) {
      const discriminator =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).type
          : undefined;
      const selected = definition.variants.find(
        (name) =>
          types[name]?.fields?.type?.literal === discriminator && discriminator !== undefined,
      );

      if (selected) return valueErrors(value, selected, path, depth + 1);

      const candidates = definition.variants.map((variant) =>
        valueErrors(value, variant, path, depth + 1),
      );

      return candidates.some((candidate) => !candidate.length)
        ? []
        : [
            `${path}: expected ${kind} (${definition.variants.join(" or ")}); inspect action=describe`,
          ];
    }

    if (!value || typeof value !== "object" || Array.isArray(value))
      return [
        `${path}: expected ${kind} object with fields ${Object.keys(definition.fields ?? {}).join(", ")}`,
      ];

    return objectErrors(value as Record<string, unknown>, definition.fields ?? {}, path, depth + 1);
  }

  function objectErrors(
    value: Record<string, unknown>,
    fields: Record<string, Field>,
    path: string,
    depth: number,
  ): string[] {
    const problems: string[] = [];

    for (const key of Object.keys(value)) {
      if (Object.hasOwn(fields, key)) continue;

      const replacement = Object.hasOwn(fields, key + "s") ? key + "s" : undefined;

      problems.push(
        `${path}.${key}: unknown parameter${replacement ? `; use ${replacement} (${fields[replacement].type}) instead` : "; inspect action=describe for allowed fields"}`,
      );
    }

    for (const [key, field] of Object.entries(fields)) {
      if (value[key] === undefined) {
        if (field.required) problems.push(`${path}.${key}: required ${field.type}`);

        continue;
      }

      if (field.literal && value[key] !== field.literal)
        problems.push(`${path}.${key}: must be ${JSON.stringify(field.literal)}`);
      else problems.push(...valueErrors(value[key], field.type, `${path}.${key}`, depth));
    }

    return problems;
  }

  const definition = telegramMethod(method);

  if (!definition) return ["Unknown Bot API method"];

  errors.push(...objectErrors(params, definition.fields ?? {}, "params", 0));

  if (method === "sendPoll" && params.type === "quiz" && params.correct_option_ids === undefined)
    errors.push(
      "params.correct_option_ids: required for quiz polls; use an array of zero-based indexes, e.g. [1]",
    );

  return errors.slice(0, 20);
}
