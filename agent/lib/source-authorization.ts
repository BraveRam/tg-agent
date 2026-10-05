export function sourceReference(value: string) {
  const text = value.trim().replace(/\/$/, "");
  const publicLink = text.match(/^(?:https?:\/\/)?t\.me\/([a-zA-Z][a-zA-Z0-9_]+)$/);

  return publicLink
    ? "@" + publicLink[1].toLowerCase()
    : text.startsWith("@")
      ? text.toLowerCase()
      : text;
}

// Derived exclusively from the authenticated owner's incoming text, never model or source output.
export function ownerJoinReferences(text: string, forwarded = false): string[] {
  if (
    forwarded ||
    !/\b(join|monitor\w*|follow|watch|subscribe)\b|keep an eye on/i.test(text) ||
    /\b(stop|pause|cancel|don't|do not)\b/i.test(text)
  )
    return [];

  return [
    ...new Set(
      (
        text.match(
          /(?:https?:\/\/)?t\.me\/(?:\+[\w-]+|joinchat\/[\w-]+|[a-zA-Z][a-zA-Z0-9_]+)|@[a-zA-Z][a-zA-Z0-9_]+/g,
        ) ?? []
      ).map(sourceReference),
    ),
  ];
}
