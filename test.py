import asyncio
import logging
import sys

import y_py as Y
import websockets
from ypy_websocket.websocket_provider import WebsocketProvider

WS_BASE_URL = "ws://localhost:5000/ws"
SPACE_ID = "jira_test"
USER = "user"
PASSWORD = "devtoken"


class WebsocketAdapter:
    def __init__(self, websocket, path: str) -> None:
        self._websocket = websocket
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except Exception:
            raise StopAsyncIteration()

    async def send(self, message: bytes) -> None:
        await self._websocket.send(message)

    async def recv(self) -> bytes:
        message = await self._websocket.recv()
        if isinstance(message, bytes):
            return message
        return message.encode("utf-8")


def ydoc_to_text(ydoc: Y.YDoc) -> str:
    text = ydoc.get_text("content")
    raw = text.to_json()
    if isinstance(raw, str):
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            return raw[1:-1]
        return raw
    return str(raw)


pending_change = False


def on_txn(_ydoc: Y.YDoc, *_args, **_kwargs):
    global pending_change
    pending_change = True


async def main():
    logging.basicConfig(level=logging.INFO)
    url = f"{WS_BASE_URL}/{SPACE_ID}?user={USER}&password={PASSWORD}"
    print("connecting", url)
    async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
        adapter = WebsocketAdapter(ws, path=f"/ws/{SPACE_ID}")
        ydoc = Y.YDoc()
        provider = WebsocketProvider(ydoc, adapter)
        provider_task = asyncio.create_task(provider.start())
        await provider.started.wait()
        print("connected")
        ydoc.observe_after_transaction(lambda *args, **kwargs: on_txn(ydoc, *args, **kwargs))

        # wait for initial sync
        for _ in range(30):
            await asyncio.sleep(0.1)
            content = ydoc_to_text(ydoc)
            if content.strip():
                break
        print("content:\n" + ydoc_to_text(ydoc))
        # keep listening
        try:
            while True:
                await asyncio.sleep(0.5)
                global pending_change
                if pending_change:
                    pending_change = False
                    content = ydoc_to_text(ydoc)
                    print("[update] len=", len(content))
        finally:
            provider.stop()
            provider_task.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
