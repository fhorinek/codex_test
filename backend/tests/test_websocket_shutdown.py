import asyncio
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server  # noqa: E402


class WebsocketShutdownTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._rooms = dict(server.websocket_server.rooms)
        self._presence = {
            key: dict(value) for key, value in server.presence.items()
        }
        self._last_snapshot = server.last_system_presence_snapshot
        self._refresh_task = server.system_shared_presence_refresh_task

    def tearDown(self):
        server.websocket_server.rooms.clear()
        server.websocket_server.rooms.update(self._rooms)
        server.presence.clear()
        server.presence.update(self._presence)
        server.last_system_presence_snapshot = self._last_snapshot
        server.system_shared_presence_refresh_task = self._refresh_task

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

    def test_system_presence_snapshot_uses_active_rooms(self):
        class Awareness:
            def __init__(self):
                now_ms = int(time.time() * 1000)
                self.meta = {7: {"last_updated": now_ms}}
                self.states = {7: {"user": {"name": "Maya"}}}

        class Room:
            awareness = Awareness()

        server.websocket_server.rooms.clear()
        server.presence.clear()
        server.websocket_server.rooms["/ws/team/alpha"] = Room()

        with patch("server.list_space_entries", side_effect=AssertionError("space scan")):
            snapshot = server.build_system_presence_snapshot()

        self.assertEqual(snapshot, {"team/alpha": ["Maya"]})

    async def test_unchanged_presence_snapshot_is_not_published(self):
        server.last_system_presence_snapshot = {}
        with patch("server.build_system_presence_snapshot", return_value={}), patch(
            "server.publish_system_shared_values",
            new_callable=AsyncMock,
        ) as publish:
            await server.publish_system_presence_snapshot()

        publish.assert_not_awaited()

    async def test_force_presence_snapshot_is_published(self):
        server.last_system_presence_snapshot = {}
        with patch("server.build_system_presence_snapshot", return_value={}), patch(
            "server.publish_system_shared_values",
            new_callable=AsyncMock,
        ) as publish:
            await server.publish_system_presence_snapshot(force=True)

        publish.assert_awaited_once()

    async def test_system_shared_values_do_not_start_idle_room(self):
        server.websocket_server.rooms.clear()

        changed = await server.publish_system_shared_values(
            {server.SYSTEM_SHARED_KEY_BACKEND_BUILD_ID: "test-build"}
        )

        room = server.websocket_server.rooms[server.SYSTEM_SHARED_WS_PATH]
        self.assertTrue(changed)
        self.assertIsNone(getattr(room, "_task_group", None))
        room._update_send_stream.close()
        room._update_receive_stream.close()

    async def test_scheduled_presence_refresh_does_not_cancel_sync_loop(self):
        sync_task = asyncio.create_task(asyncio.sleep(10))
        server.system_shared_presence_task = sync_task
        try:
            server.schedule_system_presence_snapshot(delay_seconds=10)

            self.assertFalse(sync_task.cancelled())
            self.assertIsNot(server.system_shared_presence_refresh_task, sync_task)
        finally:
            refresh_task = server.system_shared_presence_refresh_task
            if isinstance(refresh_task, asyncio.Task):
                refresh_task.cancel()
                try:
                    await refresh_task
                except asyncio.CancelledError:
                    pass
            sync_task.cancel()
            try:
                await sync_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    unittest.main()
