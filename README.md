# tg-agent

Private, single-owner Telegram assistant built with Eve. It researches public websites, runs programs in Docker, reads Telegram sources with a dedicated user account, and publishes scheduled English, Amharic, and Afaan Oromo posts.

## Run locally

Install Bun, Docker and uv. Docker must be running and accessible to your desktop account. Then:

```sh
bun install
uv venv .venv
uv pip sync --python .venv/bin/python userbot/requirements.lock
bun dev
```

First run asks for the AI Gateway key, BotFather bot token, your numeric Telegram account ID, and Telegram API ID/hash from https://my.telegram.org. It then logs in the dedicated userbot account using your phone, code, and optional 2FA password. Secrets stay in the local terminal and `.env.local`; do not send them through chat. The main agent and both specialists use `xiaomi/mimo-v2.6-pro` through AI Gateway with medium reasoning.

The bot must be an administrator with posting, editing and deletion rights in destination channels. The dedicated user account must be able to read the source and destination channels. Send your bot a private Telegram message to start. `Ctrl+C` stops all workers. A second instance sharing the data directory cannot start.

`bun dev` runs Eve on loopback, the authenticated Python reader, durable Telegram polling, and the dispatcher. There is no public webhook. An existing Bot API webhook must be removed before polling starts. Jobs run while this command is active.

While the agent works, the coordinator refreshes the owner's typing indicator every three seconds. It pauses while waiting for your input and stops refreshing when work completes, fails, or is cancelled; Telegram then clears the indicator automatically. Active work is recorded in SQLite so a coordinator restart can resume the heartbeat.

Example requests:

- “Post AI news to @mychannel in English every five minutes, sometimes with photos.”
- “Use @source and always trust it. Post at 07:00 and 15:00 Nairobi time.”
- “Pause that job.”
- “Change the channel language to Afaan Oromo.”
- “Show jobs, spending and uncertain publications.”

Supported intervals start at one minute. Clock schedules support multiple daily times and optional weekdays. Default timezone: `Africa/Nairobi`; default interval: five minutes.

The owner private chat shows interim and final assistant messages. Tool batches share an editable progress card with copyable command blocks and concise argument previews; failures update the same card, and successful completions stay quiet. Specialist and scheduled-job activity is included. Integration secrets are redacted, long messages are split, and ambiguous activity sends are recorded without blindly replaying them. Human-input buttons still work through Eve's native Telegram channel.

## Persistence and delivery

`.data/agent.sqlite` uses WAL for settings, jobs, run leases, source cursors, memory, inbound offsets, outbox, revisions and usage. `.data/userbot.session` contains the dedicated Telegram login. Eve keeps its separate durable session/workflow storage under `.eve/`; preserve both directories when backing up or restarting.

The dispatcher admits at most two active jobs and one active run per job. Missed clock slots are skipped; overdue intervals perform one current check. Job edits or pauses invalidate old runs and queued sends. Publication intents are written before sending. Verification retries perform readback only. Ambiguous sends are reconciled against destination history and remain uncertain if delivery cannot be established; they are never blindly resent.

Source changes queue correction reviews. Always-trusted source policies bypass independent corroboration, but source text cannot grant permissions. Scheduled jobs cannot modify settings or operate other destinations. Specialists have read-only integrations and no publishing tools. Real media needs reuse permission and credit; protected Telegram photos are rejected and text is the fallback.

New Telegram sources start with their latest 50 messages. After that, ordered history scans checkpoint only acknowledged batches, so live updates cannot hide messages missed during downtime. Catch-up reads at most 500 messages per source per scan and resumes from its saved checkpoint. Tracked source posts are refreshed in batches of 100 to detect older edits and deletions. Correction runs retain the affected source IDs and publications; failed reviews are queued again after a one-minute delay.

Recorded provider model costs, including specialist calls and retried priced calls, count toward the default $2 daily limit. New background calls pause when recorded spend reaches the cap; owner conversation remains available. In-flight calls can cross the cap because pricing arrives after completion. Search/infrastructure fees are separate. Unpriced background steps pause autonomous work for inspection. Cost attribution for provider failures and compaction requires live Gateway validation; do not treat recorded spend as a billing invoice.

## Checks

```sh
bun run format:check
bun run typecheck
bun run test
bun run test:python
bun run format:python:check
bun run doctor
bun run build
bun run eval
```

Use `bun run test`, because the implementation uses Node 24's SQLite module; Bun's own test runner does not provide it. Tests cover persistence, scheduler leases, ownership, source instruction restrictions in executors, duplicate stories, photos/albums, accepted-but-lost send responses, readback retries, paused sends, revisions and budget handling. Eve evals exercise natural-language job control with a real model and require an AI Gateway key.

`bun run test:telegram` requires a running app, owner credentials, a logged-in userbot, and explicitly configured disposable channels. Set `TG_TEST_CHANNELS` to JSON with `en`, `am`, and `om` channel references, plus `TG_TEST_PHOTO_URL`, `TG_TEST_PHOTO_CREDIT`, and `TG_TEST_SOURCE_URL` for a photo you may reuse. It sends marked fixtures and verifies text, photos, albums, edits, corrections and deletions. Its ledger remains under `.data/acceptance/` for cleanup if a check fails. Confirm text, photos, albums, edits, deletions and translations in each language before relying on autonomous posting. Language skills guide generation; they do not substitute for native-speaker review.

## Compatibility

Eve is pinned to 0.70.0. The official `@agent-browser/eve` 0.38.2 registry package was built against an older unsupported tool contract. `integrations/agent-browser` preserves its published implementation and rebuilds it with the current compiler during `bun install`. Docker images bake in the browser and Chromium once.

`patches/eve@0.70.0.patch` adds shared SELinux labeling to Eve's read-only Docker resource mount, required on Fedora. It also adds an `onInputResponse` hook to authenticate native Telegram button selections before resuming a waiting turn; this app accepts only the owner in their private chat. Bun uses a hoisted dependency layout so the patched framework resolves its runtime dependencies. Run `bun run format` after changes.

This release is local and single-owner. Deployment, customer accounts, signed-in website browsing, and second-level schedules are outside its scope.

### General Telegram access and live sources

`telegram_api` accepts an official Bot API method and parameters in owner-private conversations. Destinations are limited to the owner and registered channels; source references, user targets and nested chat scopes are checked independently. Indirect targets that cannot be proven are rejected. Polling, webhooks and bot shutdown remain application-owned. Sandbox files can be attached through `files`; `getFile` can download into the sandbox. Credentials never enter the sandbox or tool results. Mutations are journaled and ambiguous responses are not resent.

Telegram validates method parameters directly. The tool returns its sanitized error description, error code, response parameters and flood-wait information so the agent can research the official docs, correct rejected requests and call again. There is no local parameter-schema mirror. A small reviewed method-name list and runtime target checks retain authorization; ambiguous deliveries remain protected against retries.

The `sources` tool joins and monitors channels only on owner request, and can stop monitoring without leaving. The userbot uses short-lived signed read scopes; personal chats, unrelated groups and autonomous joins are excluded. `source_media` copies permitted media into the current sandbox. New events are saved in a separate worker SQLite inbox and forwarded until acknowledged.

Jobs accept `trigger: "scheduled" | "source_updates"`. Existing jobs remain scheduled. Source-update jobs use fixed 15-second batches, at most 50 revisions per run, one active run per job, and the existing two-run concurrency and daily budget limits. Failed batches remain pending with bounded backoff; pausing prevents sends. Joining caches recent history without posting it. Telegram deletion notifications remain best effort; published evidence is periodically rechecked.

Live monitoring acceptance: start from an authorized disposable channel and run `TG_MONITOR_TEST_CHANNEL=@channel node_modules/node/bin/node --env-file=.env.local --import tsx scripts/telegram-monitor-acceptance.ts`. It uses an isolated ledger and copied login session, joins the channel, checks new/edit/delete updates, and removes its post. Membership is retained.
