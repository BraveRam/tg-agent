import { test } from "node:test";
import assert from "node:assert/strict";

import { markdownToTelegramHtml as md } from "../agent/lib/telegram-format";

test("markdown converts to Telegram HTML and escapes raw markup", () => {
  assert.equal(
    md("**bold** and *italic* and ~~gone~~"),
    "<b>bold</b> and <i>italic</i> and <s>gone</s>",
  );
  assert.equal(md("# Title\n- one\n- two"), "<b>Title</b>\n• one\n• two");
  assert.equal(md("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.equal(
    md("[site](https://example.com/a?b=1)"),
    '<a href="https://example.com/a?b=1">site</a>',
  );
  assert.equal(md("> quoted\n> more"), "<blockquote>quoted\nmore</blockquote>");
  assert.equal(md("snake_case_name and 2*3*4"), "snake_case_name and 2*3*4");
});

test("code is preserved verbatim and not formatted", () => {
  assert.equal(md("use `a<b>**x**`"), "use <code>a&lt;b&gt;**x**</code>");
  assert.equal(
    md("```ts\nconst a = *b* < 1;\n```"),
    '<pre><code class="language-ts">const a = *b* &lt; 1;</code></pre>',
  );
  assert.equal(md("```\nplain\n```"), "<pre>plain</pre>");
});
