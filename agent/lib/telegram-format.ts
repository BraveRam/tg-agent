const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (text: string) => escapeHtml(text).replace(/"/g, "&quot;");

/**
 * Converts the common Markdown an assistant writes into Telegram's HTML parse mode.
 * HTML is used rather than MarkdownV2 because only `&`, `<` and `>` need escaping,
 * so ordinary punctuation can never make Telegram reject the message.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const stash: string[] = [];
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;

  let text = markdown.replace(/\r\n/g, "\n");

  // Code is extracted first so its contents are never interpreted as Markdown.
  text = text.replace(
    /```[ \t]*([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const body = escapeHtml(code.replace(/\n$/, ""));

      return hold(
        lang
          ? `<pre><code class="language-${escapeAttribute(lang)}">${body}</code></pre>`
          : `<pre>${body}</pre>`,
      );
    },
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    hold(`<code>${escapeHtml(code)}</code>`),
  );

  text = escapeHtml(text);

  // Links: only absolute http(s)/tg URLs become anchors.
  text = text.replace(
    /\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      hold(`<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`),
  );

  text = text
    // Headings become bold lines.
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "<b>$1</b>")
    // Bullets.
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([^\n]+?)(?<=\S)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(/(?<![\w*])\*(?=[^\s*])([^\n*]+?)(?<=[^\s*])\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<![\w_])_(?=[^\s_])([^\n_]+?)(?<=[^\s_])_(?![\w_])/g, "<i>$1</i>");

  // Block quotes (">" was escaped to "&gt;").
  text = text.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block) => {
    const inner = block
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.replace(/^&gt;[ \t]?/, ""))
      .join("\n");

    return `<blockquote>${inner}</blockquote>${block.endsWith("\n") ? "\n" : ""}`;
  });

  // Restore stashed fragments; links/code may nest inside one another's placeholders.
  for (let i = 0; i < 3; i++)
    text = text.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => stash[Number(n)]);

  return text;
}
