"""Worker contract tests; no live Telegram account needed."""

import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

_TEMP = tempfile.TemporaryDirectory(prefix="tg-userbot-test-")
os.environ["TG_DATA_DIR"] = _TEMP.name
os.environ["TELEGRAM_API_ID"] = "1"
os.environ["TELEGRAM_API_HASH"] = "0" * 32
os.environ["TG_INTERNAL_TOKEN"] = "test-internal"
from fastapi import HTTPException
import httpx
from telethon.errors import FloodWaitError
from userbot import app as worker


class WorkerTests(unittest.TestCase):
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
                    {"/health", "/resolve", "/messages", "/media"},
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
            patch.object(worker, "entity", AsyncMock(return_value="peer")),
            patch.object(worker.client, "get_messages", AsyncMock(return_value=[None])),
        ):
            result = asyncio.run(
                worker.messages(worker.MessagesRequest(channel="@test", ids=[1]))
            )
            self.assertEqual(result, {"messages": []})

    def test_protected_media_is_rejected(self):
        class Protected:
            photo = True
            noforwards = True

        with (
            patch.object(worker, "entity", AsyncMock(return_value="peer")),
            patch.object(
                worker.client, "get_messages", AsyncMock(return_value=Protected())
            ),
        ):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(
                    worker.media(worker.MediaRequest(channel="@test", messageId=1))
                )
            self.assertEqual(error.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
