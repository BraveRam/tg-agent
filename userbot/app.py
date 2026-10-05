"""Trusted, loopback-only Telegram reader. Never sends messages as the user account."""

import asyncio
import base64
import hashlib
import json
import sqlite3
import time
import contextlib
import hmac
import os
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from telethon import TelegramClient, events, errors, utils, types
from telethon.tl.functions.channels import JoinChannelRequest, GetFullChannelRequest
from telethon.tl.functions.messages import (
    CheckChatInviteRequest,
    ImportChatInviteRequest,
)

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
forward_lock = asyncio.Lock()
bearer = HTTPBearer(auto_error=False)


def unbase64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


async def authorize(
    authorization: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer)
    ] = None,
):
    if not TOKEN:
        raise HTTPException(401, "Unauthorized")
    credential = (
        authorization.removeprefix("Bearer ")
        if isinstance(authorization, str)
        else (authorization.credentials if authorization else "")
    )
    if hmac.compare_digest(credential, TOKEN):
        return {"internal": True}
    try:
        body, signature = credential.split(".")
        expected = hmac.new(TOKEN.encode(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(unbase64(signature), expected):
            raise ValueError()
        scope = json.loads(unbase64(body))
        if scope["exp"] < time.time() or scope["exp"] > time.time() + 310:
            raise ValueError()
        return scope
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(401, "Unauthorized") from None


async def channel_peer(reference, scope):
    peer = await entity(reference)
    if not isinstance(peer, types.Channel) or not peer.broadcast:
        raise HTTPException(403, "Only configured broadcast channels may be read")
    allowed = scope.get("channels", [])
    if (
        not scope.get("internal")
        and reference not in allowed
        and str(utils.get_peer_id(peer)) not in allowed
    ):
        raise HTTPException(403, "Channel outside caller scope")
    return peer


@contextmanager
def inbox():
    db = sqlite3.connect(DATA / "userbot-inbox.sqlite", timeout=5)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        "CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0)"
    )
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def forward_pending():
    async with forward_lock:
        await _forward_pending()


async def _forward_pending():
    with inbox() as db:
        rows = db.execute(
            "SELECT id,body,attempts,retry_at FROM pending ORDER BY rowid LIMIT 100", ()
        ).fetchall()
    for key, payload, attempts, retry_at in rows:
        if retry_at > time.time():
            return
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                response = await http.post(
                    EVE_URL + "/internal/sources",
                    headers={"Authorization": "Bearer " + TOKEN},
                    json=json.loads(payload),
                )
                response.raise_for_status()
            with inbox() as db:
                db.execute("DELETE FROM pending WHERE id=?", (key,))
        except Exception:
            with inbox() as db:
                db.execute(
                    "UPDATE pending SET attempts=attempts+1,retry_at=? WHERE id=?",
                    (time.time() + min(300, 2 ** min(attempts + 1, 8)), key),
                )
            raise


async def delivery_loop():
    while True:
        try:
            await forward_pending()
            source_health["delivery"] = "ready"
        except Exception:
            source_health["delivery"] = "degraded"
        await asyncio.sleep(2)


async def report_source(reference, **fields):
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(
            EVE_URL + "/internal/source-state",
            headers={"Authorization": "Bearer " + TOKEN},
            json={"reference": reference, **fields},
        )
        response.raise_for_status()


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
        "hasMedia": bool(message.photo or getattr(message, "document", None)),
        "groupedId": str(message.grouped_id) if message.grouped_id else None,
        "protected": bool(message.noforwards),
    }


async def ingest(source, messages, cursor=None, bootstrap=False):
    body = {"source": source, "messages": messages}
    if cursor is not None:
        body["cursor"] = cursor
    if bootstrap:
        body["bootstrap"] = True
    payload = json.dumps(body, sort_keys=True)
    key = hashlib.sha256(payload.encode()).hexdigest()
    with inbox() as db:
        db.execute("INSERT OR IGNORE INTO pending(id,body) VALUES(?,?)", (key, payload))
    await forward_pending()
    with inbox() as db:
        if db.execute("SELECT 1 FROM pending WHERE id=?", (key,)).fetchone():
            raise HTTPException(503, "Update queued for delivery")


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
    peer = await entity(entry.get("chatId") or entry["source"])
    if not isinstance(peer, types.Channel) or not peer.broadcast:
        raise HTTPException(403, "Only broadcast channels may be monitored")
    await report_source(
        entry["source"],
        chatId=str(utils.get_peer_id(peer)),
        membership="unknown" if peer.left else "joined",
        aliases=["@" + peer.username] if peer.username else [],
    )
    source_map[utils.get_peer_id(peer)] = entry["source"]
    if entry["cursor"]:
        batch = []
        async for message in client.iter_messages(
            peer, min_id=entry["cursor"], reverse=True, limit=500
        ):
            batch.append(serialize(message))
            if len(batch) == 100:
                await ingest(entry["source"], batch, cursor=batch[-1]["id"])
                batch = []
        if batch:
            await ingest(entry["source"], batch, cursor=batch[-1]["id"])

    recent = await rpc(client.get_messages(peer, limit=50))
    recent = [serialize(m) for m in recent if m]
    # Bootstrap a newly configured source with its recent history. Subsequent
    # refreshes detect edits but cannot skip an unfinished ordered catch-up.
    await ingest(
        entry["source"],
        recent,
        cursor=max((m["id"] for m in recent), default=0)
        if not entry["cursor"]
        else None,
        bootstrap=not bool(entry["cursor"]),
    )
    tracked_ids = list(dict.fromkeys(entry.get("trackedIds", [])))
    for start in range(0, len(tracked_ids), 100):
        ids = tracked_ids[start : start + 100]
        tracked = await rpc(client.get_messages(peer, ids=ids))
        await ingest(
            entry["source"],
            [
                serialize(m) if m else {"id": mid, "text": "", "deleted": True}
                for mid, m in zip(ids, tracked)
            ],
        )
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
                    if entry.get("membership") == "awaiting_approval":
                        invite = entry["source"].split("/")[-1].removeprefix("+")
                        checked = await rpc(client(CheckChatInviteRequest(invite)))
                        if not isinstance(checked, types.ChatInviteAlready):
                            continue
                        entry["chatId"] = str(utils.get_peer_id(checked.chat))
                        await report_source(
                            entry["source"], chatId=entry["chatId"], membership="joined"
                        )
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
    delivery = asyncio.create_task(delivery_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        delivery.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await delivery
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
    beforeId: int = Field(default=0, ge=0)
    afterId: int = Field(default=0, ge=0)
    beforeDate: float | None = None
    afterDate: float | None = None


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
async def resolve(body: ChannelRequest, scope=Depends(authorize)):
    peer = await channel_peer(body.channel, scope)
    return {
        "chatId": str(utils.get_peer_id(peer)),
        "name": getattr(peer, "title", ""),
        "username": getattr(peer, "username", None),
        "description": getattr(
            (await rpc(client(GetFullChannelRequest(peer)))).full_chat, "about", ""
        ),
    }


@app.post("/messages", operation_id="readMessages")
async def messages(body: MessagesRequest, scope=Depends(authorize)):
    from datetime import datetime, timezone

    peer = await channel_peer(body.channel, scope)
    options = (
        {"ids": body.ids}
        if body.ids
        else {
            "limit": body.limit,
            "offset_id": body.beforeId,
            "min_id": body.afterId,
            "offset_date": datetime.fromtimestamp(body.beforeDate, timezone.utc)
            if body.beforeDate
            else None,
        }
    )
    result = await rpc(client.get_messages(peer, **options))
    items = [
        serialize(m)
        for m in result
        if m and (body.afterDate is None or m.date.timestamp() >= body.afterDate)
    ]
    return {
        "messages": items,
        "nextBeforeId": min((m.id for m in result if m), default=None),
    }


@app.post("/media", operation_id="retrievePhoto")
async def media(body: MediaRequest, scope=Depends(authorize)):
    peer = await channel_peer(body.channel, scope)
    message = await rpc(client.get_messages(peer, ids=body.messageId))
    if (
        not message
        or (not message.photo and not message.document)
        or message.noforwards
    ):
        raise HTTPException(403, "Media unavailable or protected")
    directory = DATA / "media"
    directory.mkdir(mode=0o700, exist_ok=True)
    extension = (
        ".jpg" if message.photo else (getattr(message.file, "ext", None) or ".bin")
    )
    if not extension.removeprefix(".").isalnum():
        extension = ".bin"
    if message.file and message.file.size and message.file.size > 50 * 1024 * 1024:
        raise HTTPException(413, "Media exceeds 50 MB")
    file_id = str(uuid.uuid4()) + extension
    result = await rpc(client.download_media(message, str(directory / file_id)))
    if not result:
        raise HTTPException(404, "No media")
    return {
        "fileId": file_id,
        "mediaType": "image/jpeg"
        if message.photo
        else getattr(message.document, "mime_type", "application/octet-stream"),
    }


@app.post("/join", operation_id="joinSourceChannel")
async def join_source(body: ChannelRequest, scope=Depends(authorize)):
    reference = body.channel
    if scope.get("join") != reference:
        raise HTTPException(403, "Owner-authorized join required")
    try:
        if "t.me/+" in reference or "t.me/joinchat/" in reference:
            invite = reference.split("/")[-1].removeprefix("+")
            checked = await client(CheckChatInviteRequest(invite))
            if isinstance(checked, types.ChatInviteAlready):
                peer = checked.chat
            else:
                if not getattr(checked, "broadcast", False):
                    raise HTTPException(403, "Only broadcast channels may be joined")
                joined = await client(ImportChatInviteRequest(invite))
                peer = joined.chats[0]
        else:
            peer = await entity(reference)
            if not isinstance(peer, types.Channel) or not peer.broadcast:
                raise HTTPException(403, "Only broadcast channels may be joined")
            await client(JoinChannelRequest(peer))
        if not isinstance(peer, types.Channel) or not peer.broadcast:
            raise HTTPException(403, "Only broadcast channels may be joined")
        return {
            "chatId": str(utils.get_peer_id(peer)),
            "aliases": ["@" + peer.username] if peer.username else [],
            "membership": "joined",
        }
    except errors.InviteRequestSentError:
        return {"membership": "awaiting_approval", "aliases": []}
    except errors.UserAlreadyParticipantError:
        return {
            "chatId": str(utils.get_peer_id(peer)),
            "membership": "joined",
            "aliases": [],
        }
    except errors.FloodWaitError as exc:
        raise HTTPException(
            429, "Telegram flood wait", headers={"Retry-After": str(exc.seconds)}
        ) from None
    except errors.RPCError:
        raise HTTPException(400, "Channel join failed or invite invalid") from None


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
