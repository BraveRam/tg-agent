import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import { executeCustomSkills, listCustomSkills } from "../agent/lib/custom-skills";

test("custom skills persist, replay once, validate content and reject scheduled or unauthorized creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-custom-skills-"));
  const s = new Store(dir);
  const ctx = {
    callId: "create-one",
    session: { id: "owner", auth: { current: { authenticator: "local-dev", attributes: {} } } },
  };
  const input = {
    action: "create" as const,
    name: "release-notes",
    description: "Use when the owner requests release notes.",
    markdown: "Read the supplied changes. Group fixes and features. Keep the notes concise.",
  };
  try {
    const result = executeCustomSkills(input, ctx, s);
    assert.ok(!Array.isArray(result));
    assert.equal(result.name, "custom-release-notes");
    assert.deepEqual(executeCustomSkills(input, ctx, s), result);
    assert.equal(listCustomSkills(s).length, 1);
    assert.throws(
      () => executeCustomSkills(input, { ...ctx, callId: "duplicate" }, s),
      /already exists/,
    );
    assert.throws(() => executeCustomSkills({ ...input, name: "../news" }, ctx, s));
    assert.throws(() => executeCustomSkills({ ...input, markdown: " " }, ctx, s));
    assert.throws(() => executeCustomSkills(input, { session: { auth: {} } }, s), /authentication/);
    assert.throws(
      () =>
        executeCustomSkills(
          input,
          {
            ...ctx,
            session: {
              ...ctx.session,
              auth: { current: { authenticator: "local-dev", attributes: { runId: "job" } } },
            },
          },
          s,
        ),
      /Scheduled jobs/,
    );
    const reopened = new Store(dir);
    assert.equal(listCustomSkills(reopened)[0].markdown, input.markdown);
    assert.deepEqual(executeCustomSkills({ action: "list" }, ctx, reopened), [
      { name: "custom-release-notes", description: input.description },
    ]);
    const saved = executeCustomSkills(
      { action: "get", name: "custom-release-notes" },
      ctx,
      reopened,
    );
    assert.ok(!Array.isArray(saved));
    assert.ok("markdown" in saved);
    assert.equal(saved.markdown, input.markdown);
    reopened.close();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editing preserves omitted fields; deletion and replay survive restart without touching other skills", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-skill-edits-"));
  const s = new Store(dir);
  const ctx = (callId: string) => ({
    callId,
    session: { id: "owner", auth: { current: { authenticator: "local-dev", attributes: {} } } },
  });
  try {
    for (const name of ["channel-post", "notes"])
      executeCustomSkills(
        { action: "create", name, description: "Use for posts.", markdown: "Show a preview." },
        ctx(name),
        s,
      );
    const update = {
      action: "update" as const,
      name: "custom-channel-post",
      markdown: "Publish directly using the channel language and one or two images.",
    };
    const result = executeCustomSkills(update, ctx("edit"), s);
    assert.deepEqual(executeCustomSkills(update, ctx("edit"), s), result);
    assert.equal(listCustomSkills(s)[0].description, "Use for posts.");
    assert.equal(listCustomSkills(s)[0].markdown, update.markdown);
    executeCustomSkills(
      {
        action: "update",
        name: "channel-post",
        description: "Use when asked to post to a channel.",
      },
      ctx("edit-description"),
      s,
    );
    assert.equal(listCustomSkills(s)[0].markdown, update.markdown);
    assert.throws(() =>
      executeCustomSkills(
        { action: "update", name: "channel-post", markdown: " " },
        ctx("invalid"),
        s,
      ),
    );
    assert.throws(
      () => executeCustomSkills({ action: "update", name: "channel-post" }, ctx("no-changes"), s),
      /Provide/,
    );
    for (const action of ["update", "delete"] as const) {
      assert.throws(
        () =>
          executeCustomSkills({ action, name: "english", markdown: "Replacement" }, ctx(action), s),
        /not found/,
      );
      assert.throws(
        () =>
          executeCustomSkills(
            { action, name: "channel-post", markdown: "Replacement" },
            {
              ...ctx(action),
              session: {
                id: "scheduled",
                auth: { current: { authenticator: "local-dev", attributes: { runId: "job" } } },
              },
            },
            s,
          ),
        /Scheduled jobs/,
      );
    }
    const deletion = { action: "delete" as const, name: "custom-channel-post" };
    const deleted = executeCustomSkills(deletion, ctx("delete"), s);
    const reopened = new Store(dir);
    try {
      assert.deepEqual(
        listCustomSkills(reopened).map((skill) => skill.name),
        ["notes"],
      );
      assert.deepEqual(executeCustomSkills(deletion, ctx("delete"), reopened), deleted);
      assert.deepEqual(executeCustomSkills(update, ctx("edit"), reopened), result);
      assert.equal(
        listCustomSkills(reopened).length,
        1,
        "replaying an edit cannot resurrect a deleted skill",
      );
      assert.throws(
        () => executeCustomSkills({ action: "get", name: "channel-post" }, ctx("read"), reopened),
        /not found/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
