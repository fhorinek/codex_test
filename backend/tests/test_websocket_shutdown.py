import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server  # noqa: E402


class WebsocketShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_send_after_close_is_suppressed(self):
        sent_messages = []

        async def app(scope, receive, send):
            await send({"type": "websocket.close", "code": 1001})
            await send({"type": "websocket.send", "bytes": b"late"})

        async def receive():
            return {"type": "websocket.disconnect"}

        async def send(message):
            if message["type"] == "websocket.send":
                raise RuntimeError(
                    "Unexpected ASGI message 'websocket.send', after sending "
                    "'websocket.close' or response already completed."
                )
            sent_messages.append(message)

        wrapped = server._SuppressBenignShutdownASGI(app)
        await wrapped({"type": "websocket"}, receive, send)

        self.assertEqual(sent_messages, [{"type": "websocket.close", "code": 1001}])

    async def test_benign_websocket_send_error_is_suppressed(self):
        async def app(scope, receive, send):
            await send({"type": "websocket.send", "bytes": b"late"})

        async def receive():
            return {"type": "websocket.disconnect"}

        async def send(_message):
            raise RuntimeError(
                "Unexpected ASGI message 'websocket.send', after sending "
                "'websocket.close' or response already completed."
            )

        wrapped = server._SuppressBenignShutdownASGI(app)
        await wrapped({"type": "websocket"}, receive, send)


if __name__ == "__main__":
    unittest.main()
