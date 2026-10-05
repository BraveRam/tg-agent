"""Worker contract tests; no live Telegram account needed."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from datetime import datetime, timezone
from types import SimpleNamespace

_TEMP = tempfile.TemporaryDirectory(prefix="tg-userbot-test-")
os.environ["TG_DATA_DIR"] = _TEMP.name
os.environ["TELEGRAM_API_ID"] = "1"
os.environ["TELEGRAM_API_HASH"] = "0" * 32
os.environ["TG_INTERNAL_TOKEN"] = "test-internal"
from fastapi import HTTPException  # noqa: E402
import httpx  # noqa: E402
from telethon.errors import FloodWaitError  # noqa: E402
from userbot import app as worker  # noqa: E402


class WorkerTests(unittest.TestCase):
    def test_catchup_does_not_skip_more_than_one_page_after_live_update(self):
        def message(mid):
            return SimpleNamespace(
                id=mid,
                raw_text=f"Message {mid}",
                date=datetime.now(timezone.utc),
                edit_date=None,
                photo=None,
                grouped_id=None,
                noforwards=False,
            )

        acknowledged = []
        saved_cursor = 10

        async def ingest(source, messages, cursor=None, bootstrap=False):
            nonlocal saved_cursor
            acknowledged.extend(m["id"] for m in messages)
            if cursor is not None:
                saved_cursor = max(saved_cursor, cursor)

        async def history(peer, min_id, reverse, limit):
            self.assertTrue(reverse)
            for mid in range(min_id + 1, min(610, min_id + limit) + 1):
                yield message(mid)

        with (
            patch.object(worker, "entity", AsyncMock(return_value=self.peer())),
            patch.object(worker, "report_source", AsyncMock()),
            patch.object(worker.utils, "get_peer_id", return_value=1),
            patch.object(worker.client, "iter_messages", history),
            patch.object(
                worker.client, "get_messages", AsyncMock(return_value=[message(610)])
            ),
            patch.object(worker, "ingest", ingest),
        ):
            asyncio.run(worker.ingest("@source", [worker.serialize(message(610))]))
            self.assertEqual(saved_cursor, 10)
            asyncio.run(worker.scan({"source": "@source", "cursor": saved_cursor}))
            self.assertEqual(saved_cursor, 510)
            asyncio.run(worker.scan({"source": "@source", "cursor": saved_cursor}))
            self.assertEqual(saved_cursor, 610)
            self.assertTrue(set(range(11, 611)).issubset(acknowledged))

    def test_catchup_resumes_at_last_acknowledged_batch_after_failure(self):
        def message(mid):
            return SimpleNamespace(
                id=mid,
                raw_text=str(mid),
                date=datetime.now(timezone.utc),
                edit_date=None,
                photo=None,
                grouped_id=None,
                noforwards=False,
            )

        saved_cursor = 10
        calls = 0

        async def ingest(source, messages, cursor=None, bootstrap=False):
            nonlocal saved_cursor, calls
            calls += 1
            if calls == 2:
                raise httpx.ConnectError("Dispatcher unavailable")
            if cursor is not None:
                saved_cursor = cursor

        async def history(peer, min_id, reverse, limit):
            for mid in range(min_id + 1, 261):
                yield message(mid)

        with (
            patch.object(worker, "entity", AsyncMock(return_value=self.peer())),
            patch.object(worker, "report_source", AsyncMock()),
            patch.object(worker.utils, "get_peer_id", return_value=1),
            patch.object(worker.client, "iter_messages", history),
            patch.object(worker.client, "get_messages", AsyncMock(return_value=[])),
            patch.object(worker, "ingest", ingest),
        ):
            with self.assertRaises(httpx.ConnectError):
                asyncio.run(worker.scan({"source": "@source", "cursor": saved_cursor}))
            self.assertEqual(saved_cursor, 110)
            asyncio.run(worker.scan({"source": "@source", "cursor": saved_cursor}))
            self.assertEqual(saved_cursor, 260)

    def test_bootstrap_and_tracked_reads_are_bounded(self):
        reads = AsyncMock(return_value=[])
        ingest = AsyncMock()
        with (
            patch.object(worker, "entity", AsyncMock(return_value=self.peer())),
            patch.object(worker, "report_source", AsyncMock()),
            patch.object(worker.utils, "get_peer_id", return_value=1),
            patch.object(worker.client, "get_messages", reads),
            patch.object(worker, "ingest", ingest),
        ):
            asyncio.run(
                worker.scan(
                    {
                        "source": "@source",
                        "cursor": 0,
                        "trackedIds": list(range(1, 251)),
                    }
                )
            )
        self.assertEqual(
            [len(c.kwargs["ids"]) for c in reads.call_args_list[1:]], [100, 100, 50]
        )
        self.assertEqual(
            ingest.call_args_list[0].kwargs, {"cursor": 0, "bootstrap": True}
        )

    def test_authentication_and_schema(self):
        async def check():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=worker.app), base_url="http://test"
            ) as client:
                self.assertEqual((await client.get("/health")).status_code, 401)
                self.assertEqual((await client.get("/openapi.json")).status_code, 401)
                response = await client.get(
                    "/openapi.json", headers={"Authorization": "Bearer test-internal"}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    set(response.json()["paths"]),
                    {"/health", "/resolve", "/messages", "/media", "/join"},
                )

        asyncio.run(check())

    def test_flood_wait_preserves_retry_delay(self):
        async def operation():
            raise FloodWaitError(request=None, capture=35)

        with self.assertRaises(HTTPException) as error:
            asyncio.run(worker.rpc(operation()))
        self.assertEqual(error.exception.status_code, 429)
        self.assertEqual(error.exception.headers["Retry-After"], "35")

    def test_readback_filters_missing_messages(self):
        with (
            patch.object(worker, "channel_peer", AsyncMock(return_value="peer")),
            patch.object(worker.client, "get_messages", AsyncMock(return_value=[None])),
        ):
            result = asyncio.run(
                worker.messages(worker.MessagesRequest(channel="@test", ids=[1]))
            )
            self.assertEqual(result, {"messages": [], "nextBeforeId": None})

    def test_protected_media_is_rejected(self):
        class Protected:
            photo = True
            noforwards = True

        with (
            patch.object(worker, "entity", AsyncMock(return_value=self.peer())),
            patch.object(worker, "report_source", AsyncMock()),
            patch.object(
                worker.client, "get_messages", AsyncMock(return_value=Protected())
            ),
        ):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(
                    worker.media(
                        worker.MediaRequest(channel="@test", messageId=1),
                        {"internal": True},
                    )
                )
            self.assertEqual(error.exception.status_code, 403)

    def peer(self):
        return worker.types.Channel(
            id=123,
            title="Source",
            photo=worker.types.ChatPhotoEmpty(),
            date=datetime.now(timezone.utc),
            broadcast=True,
        )

    def test_collection_rejects_personal_chats_and_groups(self):
        async def verify():
            group = self.peer()
            group.broadcast = False
            for peer in ["personal-chat", group]:
                with patch.object(worker, "entity", AsyncMock(return_value=peer)):
                    with self.assertRaises(HTTPException) as error:
                        await worker.scan({"source": "@source", "cursor": 0})
                    self.assertEqual(error.exception.status_code, 403)

        asyncio.run(verify())

    def signed(self, claims):
        body = (
            base64.urlsafe_b64encode(
                json.dumps({**claims, "exp": time.time() + 300}).encode()
            )
            .decode()
            .rstrip("=")
        )
        signature = (
            base64.urlsafe_b64encode(
                hmac.new(b"test-internal", body.encode(), hashlib.sha256).digest()
            )
            .decode()
            .rstrip("=")
        )
        return body + "." + signature

    def test_scoped_credentials_and_channel_enforcement(self):
        async def check():
            scope = await worker.authorize(
                "Bearer "
                + self.signed(
                    {"channels": [str(worker.utils.get_peer_id(self.peer()))]}
                )
            )
            with patch.object(worker, "entity", AsyncMock(return_value=self.peer())):
                await worker.channel_peer("@source", scope)
                with self.assertRaises(HTTPException) as denied:
                    await worker.channel_peer("@other", {"channels": []})
                self.assertEqual(denied.exception.status_code, 403)
            with patch.object(
                worker, "entity", AsyncMock(return_value=worker.types.User(id=1))
            ):
                with self.assertRaises(HTTPException):
                    await worker.channel_peer("1", {"internal": True})
            with self.assertRaises(HTTPException):
                await worker.authorize("Bearer " + self.signed({"channels": []}) + "x")
            # A correctly signed expired payload is also rejected.
            body = (
                base64.urlsafe_b64encode(
                    json.dumps({"channels": [], "exp": 0}).encode()
                )
                .decode()
                .rstrip("=")
            )
            signature = (
                base64.urlsafe_b64encode(
                    hmac.new(b"test-internal", body.encode(), hashlib.sha256).digest()
                )
                .decode()
                .rstrip("=")
            )
            with self.assertRaises(HTTPException):
                await worker.authorize("Bearer " + body + "." + signature)

        asyncio.run(check())

    def test_owner_join_public_private_pending_and_invalid_invite(self):
        async def check():
            peer = self.peer()
            with (
                patch.object(worker, "entity", AsyncMock(return_value=peer)),
                patch.object(worker, "client", AsyncMock()),
            ):
                result = await worker.join_source(
                    worker.ChannelRequest(channel="@source"), {"join": "@source"}
                )
                self.assertEqual(result["membership"], "joined")
                with self.assertRaises(HTTPException):
                    await worker.join_source(
                        worker.ChannelRequest(channel="@source"),
                        {"channels": ["@source"]},
                    )
            invite = "https://t.me/+secret"
            with patch.object(
                worker,
                "client",
                AsyncMock(
                    side_effect=[
                        SimpleNamespace(broadcast=True),
                        worker.errors.InviteRequestSentError(request=None),
                    ]
                ),
            ):
                result = await worker.join_source(
                    worker.ChannelRequest(channel=invite), {"join": invite}
                )
                self.assertEqual(result["membership"], "awaiting_approval")
            with patch.object(
                worker,
                "client",
                AsyncMock(
                    side_effect=worker.errors.InviteHashInvalidError(request=None)
                ),
            ):
                with self.assertRaises(HTTPException) as invalid:
                    await worker.join_source(
                        worker.ChannelRequest(channel=invite), {"join": invite}
                    )
                self.assertEqual(invalid.exception.status_code, 400)
            with (
                patch.object(worker, "entity", AsyncMock(return_value=peer)),
                patch.object(
                    worker,
                    "client",
                    AsyncMock(
                        side_effect=worker.errors.UserAlreadyParticipantError(
                            request=None
                        )
                    ),
                ),
            ):
                self.assertEqual(
                    (
                        await worker.join_source(
                            worker.ChannelRequest(channel="@source"),
                            {"join": "@source"},
                        )
                    )["membership"],
                    "joined",
                )

        asyncio.run(check())

    def test_worker_updates_survive_failure_and_forward_only_after_acknowledgment(self):
        from pathlib import Path

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "DATA", Path(directory)),
        ):

            async def check():
                with patch.object(
                    worker,
                    "forward_pending",
                    AsyncMock(side_effect=ConnectionError("offline")),
                ):
                    for _ in range(2):
                        with self.assertRaises(ConnectionError):
                            await worker.ingest("@source", [{"id": 1, "text": "New"}])
                with worker.inbox() as db:
                    self.assertEqual(
                        db.execute("SELECT COUNT(*) FROM pending").fetchone()[0], 1
                    )
                response = httpx.Response(
                    200, json={"ok": True}, request=httpx.Request("POST", "http://test")
                )
                http = AsyncMock()
                http.post.return_value = response
                with patch.object(worker.httpx, "AsyncClient") as client:
                    client.return_value.__aenter__.return_value = http
                    await worker.forward_pending()
                with worker.inbox() as db:
                    self.assertEqual(
                        db.execute("SELECT COUNT(*) FROM pending").fetchone()[0], 0
                    )

            asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
