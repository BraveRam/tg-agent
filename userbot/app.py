"""Trusted, loopback-only Telegram reader. Never sends messages as the user account."""

import asyncio
import contextlib
import hmac
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from telethon import TelegramClient, events, errors, utils

DATA = Path(os.environ.get("TG_DATA_DIR", ".data")).resolve()
DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
TOKEN = os.environ.get("TG_INTERNAL_TOKEN", "")
EVE_URL = f"http://127.0.0.1:{os.environ.get('TG_PORT', '2000')}"
client = TelegramClient(
    str(DATA / "userbot"),
    int(os.environ.get("TELEGRAM_API_ID", "0")),
    os.environ.get("TELEGRAM_API_HASH", ""),
    auto_reconnect=True,
    connection_retries=5,
    flood_sleep_threshold=0,
)
source_map: dict[int, str] = {}
source_health: dict[str, str] = {}


async def authorize(authorization: Annotated[str | None, Header()] = None):
    if not TOKEN or not hmac.compare_digest(authorization or "", "Bearer " + TOKEN):
        raise HTTPException(401, "Unauthorized")


async def rpc(operation):
    try:
        return await operation
    except errors.FloodWaitError as exc:
        raise HTTPException(
            429, "Telegram flood wait", headers={"Retry-After": str(exc.seconds)}
        ) from None
    except (ValueError, errors.RPCError):
        raise HTTPException(400, "Channel/message inaccessible") from None


async def entity(reference: str):
    return await rpc(
        client.get_entity(
            int(reference) if reference.lstrip("-").isdigit() else reference
        )
    )


def serialize(message):
    return {
        "id": message.id,
        "text": message.raw_text or "",
        "date": message.date.timestamp(),
        "editedAt": message.edit_date.timestamp() if message.edit_date else None,
        "hasMedia": bool(message.photo),
        "groupedId": str(message.grouped_id) if message.grouped_id else None,
        "protected": bool(message.noforwards),
    }


async def ingest(source, messages):
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(
            EVE_URL + "/internal/sources",
            headers={"Authorization": "Bearer " + TOKEN},
            json={"source": source, "messages": messages},
        )
        response.raise_for_status()


async def on_message(event):
    source = source_map.get(event.chat_id)
    if source:
        try:
            await ingest(source, [serialize(event.message)])
        except Exception:
            pass  # Periodic history reconciliation recovers missed updates.


async def on_deleted(event):
    source = source_map.get(event.chat_id)
    if source:
        try:
            await ingest(
                source,
                [{"id": i, "text": "", "deleted": True} for i in event.deleted_ids],
            )
        except Exception:
            pass


async def scan(entry):
    peer = await entity(entry["source"])
    source_map[utils.get_peer_id(peer)] = entry["source"]
    recent = await rpc(client.get_messages(peer, limit=50))
    await ingest(entry["source"], [serialize(m) for m in recent if m])
    if entry.get("trackedIds"):
        tracked = await rpc(client.get_messages(peer, ids=entry["trackedIds"]))
        await ingest(
            entry["source"],
            [
                serialize(m) if m else {"id": mid, "text": "", "deleted": True}
                for mid, m in zip(entry["trackedIds"], tracked)
            ],
        )
    if entry["cursor"]:
        async for message in client.iter_messages(
            peer, min_id=entry["cursor"], reverse=True, limit=500
        ):
            await ingest(entry["source"], [serialize(message)])
    source_health[entry["source"]] = "ready"


async def collect():
    while True:
        delay = 60
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                response = await http.get(
                    EVE_URL + "/internal/sources",
                    headers={"Authorization": "Bearer " + TOKEN},
                )
                response.raise_for_status()
                sources = response.json()["sources"]
            enabled = {entry["source"] for entry in sources}
            for chat_id, source in list(source_map.items()):
                if source not in enabled:
                    del source_map[chat_id]
            for entry in sources:
                try:
                    await scan(entry)
                except HTTPException as exc:
                    source_health[entry["source"]] = "degraded"
                    if exc.status_code == 429:
                        delay = max(60, int(exc.headers.get("Retry-After", "60")))
                        break  # Flood waits apply to the account, not just one source.
                except errors.FloodWaitError as exc:
                    source_health[entry["source"]] = "degraded"
                    delay = max(60, exc.seconds)
                    break
                except Exception:
                    source_health[entry["source"]] = "degraded"
                    # One inaccessible source does not starve other channels.
        except Exception:
            source_health["dispatcher"] = "degraded"
        await asyncio.sleep(delay)


@asynccontextmanager
async def lifespan(app):
    os.umask(0o077)
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Userbot login required: run the local setup first")
    client.add_event_handler(on_message, events.NewMessage())
    client.add_event_handler(on_message, events.MessageEdited())
    client.add_event_handler(on_deleted, events.MessageDeleted())
    task = asyncio.create_task(collect())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await client.disconnect()


app = FastAPI(
    title="tg-agent userbot reader",
    lifespan=lifespan,
    dependencies=[Depends(authorize)],
)


class ChannelRequest(BaseModel):
    channel: str


class MessagesRequest(ChannelRequest):
    ids: list[int] | None = Field(default=None, max_length=100)
    limit: int = Field(default=30, ge=1, le=100)


class MediaRequest(ChannelRequest):
    messageId: int = Field(gt=0)


@app.get("/health", operation_id="userbotHealth")
async def health():
    return {
        "connected": client.is_connected(),
        "sources": len(source_map),
        "sourceHealth": source_health,
    }


@app.post("/resolve", operation_id="resolveChannel")
async def resolve(body: ChannelRequest):
    peer = await entity(body.channel)
    return {
        "chatId": str(utils.get_peer_id(peer)),
        "name": getattr(peer, "title", ""),
        "username": getattr(peer, "username", None),
    }


@app.post("/messages", operation_id="readMessages")
async def messages(body: MessagesRequest):
    peer = await entity(body.channel)
    result = await rpc(client.get_messages(peer, ids=body.ids, limit=body.limit))
    return {"messages": [serialize(m) for m in result if m]}


@app.post("/media", operation_id="retrievePhoto")
async def media(body: MediaRequest):
    peer = await entity(body.channel)
    message = await rpc(client.get_messages(peer, ids=body.messageId))
    if not message or not message.photo or message.noforwards:
        raise HTTPException(403, "Photo unavailable or protected")
    directory = DATA / "media"
    directory.mkdir(mode=0o700, exist_ok=True)
    file_id = str(uuid.uuid4()) + ".jpg"
    result = await rpc(client.download_media(message, str(directory / file_id)))
    if not result:
        raise HTTPException(404, "No photo")
    return {"fileId": file_id}


# FastAPI's generated OpenAPI route is not covered by global dependencies.
@app.middleware("http")
async def schema_auth(request, call_next):
    if request.url.path in ("/openapi.json", "/docs", "/redoc"):
        if not TOKEN or not hmac.compare_digest(
            request.headers.get("authorization", ""), "Bearer " + TOKEN
        ):
            from starlette.responses import JSONResponse

            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)
