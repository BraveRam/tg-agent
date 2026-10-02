import asyncio
from getpass import getpass
import os
from pathlib import Path
from telethon import TelegramClient


async def main():
    os.umask(0o077)
    data = Path(os.environ.get("TG_DATA_DIR", ".data")).resolve()
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    client = TelegramClient(
        str(data / "userbot"),
        int(os.environ["TELEGRAM_API_ID"]),
        os.environ["TELEGRAM_API_HASH"],
    )
    await client.start(
        code_callback=lambda: getpass("Telegram login code: "),
        password=lambda: getpass("Telegram 2FA password: "),
    )  # Phone, login code, and 2FA stay in the local terminal.
    me = await client.get_me()
    print("Dedicated userbot session is ready (account ID %s)." % me.id)
    await client.disconnect()


asyncio.run(main())
