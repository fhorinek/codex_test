import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from contextlib import AsyncExitStack, ExitStack
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

    async def test_room_stop_keeps_group_for_buffered_broadcast_updates(self):
        class Updates:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def __aiter__(self): return self
            async def __anext__(self): return b'buffered update'
        room = server.YRoom()
        scope = SimpleNamespace(cancel_called=False)
        scope.cancel = lambda: setattr(scope, 'cancel_called', True)
        group = SimpleNamespace(cancel_scope=scope)
        room._task_group = group
        room._update_receive_stream.close()
        room._update_receive_stream = Updates()
        room.stop()
        self.assertIs(room._task_group, group)
        await room._broadcast_updates()
        room._update_send_stream.close()

    async def test_room_context_exit_clears_group_after_broadcaster_stops(self):
        room = server.YRoom()
        scope = SimpleNamespace(cancel_called=False)
        scope.cancel = lambda: setattr(scope, 'cancel_called', True)
        group = SimpleNamespace(cancel_scope=scope)
        room._task_group = group
        async def exit_group(*args):
            self.assertIs(room._task_group, group)
            self.assertTrue(scope.cancel_called)
        room._exit_stack = SimpleNamespace(__aexit__=exit_group)
        await room.__aexit__(None, None, None)
        self.assertIsNone(room._task_group)
        room._update_send_stream.close()
        room._update_receive_stream.close()

    async def test_http_return_without_body_is_completed(self):
        for started in (False, True):
            messages = []
            async def app(scope, receive, send):
                if started:
                    await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            async def receive(): return {'type': 'http.disconnect'}
            async def send(message): messages.append(message)
            await server._SuppressBenignShutdownASGI(app)({'type': 'http'}, receive, send)
            self.assertEqual(messages[-1], {'type': 'http.response.body', 'body': b'', 'more_body': False})
            self.assertEqual(messages[0]['status'], 200 if started else 204)

    async def test_real_room_cancels_and_releases_group(self):
        from anyio import create_task_group
        room = server.YRoom()
        async with create_task_group() as group:
            await group.start(room.start)
            room._update_send_stream.send_nowait(b'buffered update')
            room.stop()
        self.assertIsNone(room._task_group)
        room._update_send_stream.close()

    async def test_main_finishes_worker_cleanup_under_room_scope_cancellation(self):
        from anyio import create_task_group
        class Rooms:
            async def __aenter__(self):
                self.stack = AsyncExitStack()
                self.group = await self.stack.enter_async_context(create_task_group())
                return self
            async def __aexit__(self, *args): return await self.stack.__aexit__(*args)
        rooms = Rooms()
        class HttpServer:
            started = True
            async def serve(self):
                rooms.group.cancel_scope.cancel()
                await asyncio.sleep(0)
        async def loop(*args): await asyncio.sleep(100)
        old_sync = server.system_shared_presence_task
        with ExitStack() as stack:
            for name in ('load_users_store', 'ensure_jira_daemon_credentials'):
                stack.enter_context(patch.object(server, name))
            for name in ('migrate_tab_spaces', 'publish_system_shared_values'):
                stack.enter_context(patch.object(server, name, new_callable=AsyncMock))
            for name in ('system_shared_presence_sync_loop', 'reconcile_tabs_loop', 'jira_daemon_supervisor'):
                stack.enter_context(patch.object(server, name, side_effect=loop))
            stack.enter_context(patch.object(server, 'websocket_server', rooms))
            stack.enter_context(patch.object(server.uvicorn, 'Server', return_value=HttpServer()))
            cleanup = stack.enter_context(patch.object(server.jira_daemons, 'shutdown', new_callable=AsyncMock))
            try:
                await server.main()
                cleanup.assert_awaited_once()
                self.assertIsNone(server.system_shared_presence_task)
            finally:
                server.system_shared_presence_task = old_sync

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
