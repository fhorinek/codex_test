import asyncio
import base64
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs

from typing import Any, Dict, List, Optional, Tuple

import y_py as Y
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from ypy_websocket import WebsocketServer, YRoom
from ypy_websocket.asgi_server import ASGIServer
from ypy_websocket.ystore import FileYStore
import uvicorn

ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"
SPACES_DIR = Path(__file__).resolve().parent / "spaces"
SPACES_DIR.mkdir(parents=True, exist_ok=True)
YSTORE_DIR = Path(__file__).resolve().parent / "ystore"
YSTORE_DIR.mkdir(parents=True, exist_ok=True)
USERS_FILE = Path(__file__).resolve().parent / "users.txt"

if not USERS_FILE.exists():
    USERS_FILE.write_text("user:devtoken\n", encoding="utf-8")

PRESENCE_TTL = 40
presence: Dict[str, Dict[str, float]] = {}
space_save_tasks: Dict[str, asyncio.Task] = {}
SPACE_SAVE_DELAY = 0.5


def sanitize_space(space_id: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", space_id or ""):
        raise HTTPException(status_code=400, detail="Invalid space id.")
    return space_id


def load_users() -> Dict[str, str]:
    users: Dict[str, str] = {}
    if not USERS_FILE.exists():
        return users
    for line in USERS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        username, password = line.split(":", 1)
        username = username.strip()
        password = password.strip()
        if username:
            users[username] = password
    return users


def verify_user(username: str, password: str) -> bool:
    users = load_users()
    return users.get(username) == password


def parse_basic_auth(authorization: Optional[str]) -> Optional[Tuple[str, str]]:
    if not authorization or not authorization.startswith("Basic "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        decoded = base64.b64decode(token).decode("utf-8")
    except Exception:
        return None
    if ":" not in decoded:
        return None
    username, password = decoded.split(":", 1)
    return username, password


def require_auth(
    authorization: Optional[str] = Header(default=None),
    user: Optional[str] = Query(default=None),
    password: Optional[str] = Query(default=None),
) -> str:
    basic = parse_basic_auth(authorization)
    if basic:
        username, pwd = basic
        if verify_user(username, pwd):
            return username
    if user and password and verify_user(user, password):
        return user
    raise HTTPException(status_code=401, detail="Unauthorized")


def space_path(space_id: str) -> Path:
    safe = sanitize_space(space_id)
    return SPACES_DIR / f"{safe}.txt"


def ystore_path(space_id: str) -> Path:
    safe = sanitize_space(space_id)
    return YSTORE_DIR / f"{safe}.ystore"


def room_name(space_id: str) -> str:
    return f"/ws/{sanitize_space(space_id)}"


def ydoc_to_text(ydoc: Y.YDoc) -> str:
    text = ydoc.get_text("content")
    return json.loads(text.to_json())


def replace_ydoc_text(ydoc: Y.YDoc, content: str) -> None:
    text = ydoc.get_text("content")

    def apply(txn):
        if len(text):
            text.delete_range(txn, 0, len(text))
        if content:
            text.insert(txn, 0, content)

    ydoc.transact(apply)


def schedule_space_snapshot(space_id: str, room) -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        content = ydoc_to_text(room.ydoc)
        space_path(space_id).write_text(content, encoding="utf-8")
        return

    if space_id in space_save_tasks:
        space_save_tasks[space_id].cancel()

    async def _save():
        try:
            await asyncio.sleep(SPACE_SAVE_DELAY)
            content = ydoc_to_text(room.ydoc)
            space_path(space_id).write_text(content, encoding="utf-8")
        except asyncio.CancelledError:
            return
        finally:
            space_save_tasks.pop(space_id, None)

    space_save_tasks[space_id] = asyncio.create_task(_save())


async def hydrate_room_from_storage(space_id: str, room) -> None:
    store_path = ystore_path(space_id)
    if store_path.exists():
        await room.ystore.apply_updates(room.ydoc)
    else:
        content_path = space_path(space_id)
        if content_path.exists():
            content = content_path.read_text(encoding="utf-8")
            if content:
                replace_ydoc_text(room.ydoc, content)
                await room.ystore.encode_state_as_update(room.ydoc)
    room.ready = True
    schedule_space_snapshot(space_id, room)


def attach_snapshot_hook(space_id: str, room) -> None:
    if getattr(room, "_snapshot_hook", False):
        return

    def _after_txn(*_args, **_kwargs):
        schedule_space_snapshot(space_id, room)

    room.ydoc.observe_after_transaction(_after_txn)
    room._snapshot_hook = True


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/spaces")
def list_spaces(user: str = Depends(require_auth)) -> Dict[str, Any]:
    spaces = sorted(path.stem for path in SPACES_DIR.glob("*.txt"))
    data = [
        {"id": space_id, "users": users_for_space(space_id)}
        for space_id in spaces
    ]
    return {"spaces": data, "user": user}


@app.get("/api/spaces/{space_id}")
def read_space(space_id: str, user: str = Depends(require_auth)) -> Response:
    path = space_path(space_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    return Response(path.read_text(encoding="utf-8"), media_type="text/plain")


@app.put("/api/spaces/{space_id}")
def write_space(
    space_id: str,
    content: str = Body(default="", media_type="text/plain"),
    user: str = Depends(require_auth),
) -> Dict[str, Any]:
    path = space_path(space_id)
    path.write_text(content, encoding="utf-8")
    room = websocket_server.rooms.get(room_name(space_id))
    if room:
        replace_ydoc_text(room.ydoc, content)
        schedule_space_snapshot(space_id, room)
    else:
        store_path = ystore_path(space_id)
        if store_path.exists():
            store_path.unlink()
    return {"ok": True}


@app.post("/api/spaces/{space_id}")
def create_space(space_id: str, user: str = Depends(require_auth)) -> Dict[str, Any]:
    path = space_path(space_id)
    if path.exists():
        raise HTTPException(status_code=409, detail="Space already exists.")
    path.write_text("", encoding="utf-8")
    return {"ok": True}


@app.delete("/api/spaces/{space_id}")
def delete_space(space_id: str, user: str = Depends(require_auth)) -> Dict[str, Any]:
    path = space_path(space_id)
    if path.exists():
        path.unlink()
    store_path = ystore_path(space_id)
    if store_path.exists():
        store_path.unlink()
    presence.pop(space_id, None)
    return {"ok": True}


@app.post("/api/spaces/{space_id}/rename")
def rename_space(
    space_id: str,
    payload: Dict[str, Any] = Body(default={}),
    user: str = Depends(require_auth),
) -> Dict[str, Any]:
    source = space_path(space_id)
    if not source.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    new_name = ""
    if isinstance(payload, dict):
        candidate = payload.get("name") or payload.get("id") or payload.get("space")
        if isinstance(candidate, str):
            new_name = candidate.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Invalid space id.")
    target_id = sanitize_space(new_name)
    target = space_path(target_id)
    if target.exists():
        raise HTTPException(status_code=409, detail="Space already exists.")
    source.rename(target)
    source_store = ystore_path(space_id)
    target_store = ystore_path(target_id)
    if source_store.exists():
        source_store.rename(target_store)
    room = websocket_server.rooms.get(room_name(space_id))
    if room:
        websocket_server.rename_room(to_name=room_name(target_id), from_room=room)
        schedule_space_snapshot(target_id, room)
    if space_id in presence:
        presence[target_id] = presence.pop(space_id)
    return {"ok": True, "id": target_id}


@app.post("/api/spaces/{space_id}/presence")
def update_presence(space_id: str, user: str = Depends(require_auth)) -> Dict[str, Any]:
    space_path(space_id)
    mark_presence(space_id, user)
    return {"ok": True}


@app.delete("/api/spaces/{space_id}/presence")
def clear_presence(space_id: str, user: str = Depends(require_auth)) -> Dict[str, Any]:
    space_path(space_id)
    remove_presence(space_id, user)
    return {"ok": True}


def cleanup_presence() -> None:
    now = time.time()
    for space_id in list(presence.keys()):
        users = presence[space_id]
        stale = [name for name, ts in users.items() if now - ts > PRESENCE_TTL]
        for name in stale:
            users.pop(name, None)
        if not users:
            presence.pop(space_id, None)


def mark_presence(space_id: str, username: str) -> None:
    cleanup_presence()
    presence.setdefault(space_id, {})[username] = time.time()


def remove_presence(space_id: str, username: str) -> None:
    users = presence.get(space_id)
    if not users:
        return
    users.pop(username, None)
    if not users:
        presence.pop(space_id, None)


def users_for_space(space_id: str) -> List[str]:
    cleanup_presence()
    users = presence.get(space_id, {})
    return sorted(users.keys())


def space_from_path(path: str) -> Optional[str]:
    if "/ws/" not in path:
        return None
    tail = path.split("/ws/", 1)[1]
    if not tail:
        return None
    name = tail.split("/", 1)[0]
    try:
        return sanitize_space(name)
    except HTTPException:
        return None


def ws_credentials(scope: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    query = parse_qs(scope.get("query_string", b"").decode())
    user = query.get("user", [None])[0] or query.get("username", [None])[0]
    password = query.get("pass", [None])[0] or query.get("password", [None])[0]
    return user, password


async def on_connect(_message: Dict[str, Any], scope: Dict[str, Any]) -> bool:
    user, password = ws_credentials(scope)
    if not user or not password or not verify_user(user, password):
        return True
    space_id = space_from_path(scope.get("path", ""))
    if space_id:
        mark_presence(space_id, user)
    return False


class PersistentWebsocketServer(WebsocketServer):
    async def get_room(self, name: str):
        if name not in self.rooms.keys():
            space_id = space_from_path(name)
            if space_id:
                store = FileYStore(str(ystore_path(space_id)))
                room = YRoom(ready=False, ystore=store, log=self.log)
                self.rooms[name] = room
                await hydrate_room_from_storage(space_id, room)
                attach_snapshot_hook(space_id, room)
            else:
                self.rooms[name] = YRoom(ready=self.rooms_ready, log=self.log)
        room = self.rooms[name]
        await self.start_room(room)
        return room


websocket_server = PersistentWebsocketServer()
app.mount("/ws", ASGIServer(websocket_server, on_connect=on_connect))
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")


async def main() -> None:
    config = uvicorn.Config(app, host="0.0.0.0", port=5000, log_level="info")
    server = uvicorn.Server(config)
    async with websocket_server:
        await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
