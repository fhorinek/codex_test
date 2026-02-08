import asyncio
import base64
import re
import time
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from ypy_websocket import WebsocketServer
from ypy_websocket.asgi_server import ASGIServer
import uvicorn

ROOT_DIR = Path(__file__).resolve().parents[1]
SPACES_DIR = Path(__file__).resolve().parent / "spaces"
SPACES_DIR.mkdir(parents=True, exist_ok=True)
USERS_FILE = Path(__file__).resolve().parent / "users.txt"

if not USERS_FILE.exists():
    USERS_FILE.write_text("user:devtoken\n", encoding="utf-8")

PRESENCE_TTL = 40
presence: dict[str, dict[str, float]] = {}


def sanitize_space(space_id: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", space_id or ""):
        raise HTTPException(status_code=400, detail="Invalid space id.")
    return space_id


def load_users() -> dict[str, str]:
    users: dict[str, str] = {}
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


def parse_basic_auth(authorization: str | None) -> tuple[str, str] | None:
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
    authorization: str | None = Header(default=None),
    user: str | None = Query(default=None),
    password: str | None = Query(default=None),
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


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/spaces")
def list_spaces(user: str = Depends(require_auth)) -> dict:
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
) -> dict:
    path = space_path(space_id)
    path.write_text(content, encoding="utf-8")
    return {"ok": True}


@app.post("/api/spaces/{space_id}")
def create_space(space_id: str, user: str = Depends(require_auth)) -> dict:
    path = space_path(space_id)
    if path.exists():
        return {"ok": True}
    path.write_text("", encoding="utf-8")
    return {"ok": True}


@app.delete("/api/spaces/{space_id}")
def delete_space(space_id: str, user: str = Depends(require_auth)) -> dict:
    path = space_path(space_id)
    if path.exists():
        path.unlink()
    presence.pop(space_id, None)
    return {"ok": True}


@app.post("/api/spaces/{space_id}/presence")
def update_presence(space_id: str, user: str = Depends(require_auth)) -> dict:
    space_path(space_id)
    mark_presence(space_id, user)
    return {"ok": True}


@app.delete("/api/spaces/{space_id}/presence")
def clear_presence(space_id: str, user: str = Depends(require_auth)) -> dict:
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


def users_for_space(space_id: str) -> list[str]:
    cleanup_presence()
    users = presence.get(space_id, {})
    return sorted(users.keys())


def space_from_path(path: str) -> str | None:
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


def ws_credentials(scope: dict) -> tuple[str | None, str | None]:
    query = parse_qs(scope.get("query_string", b"").decode())
    user = query.get("user", [None])[0] or query.get("username", [None])[0]
    password = query.get("pass", [None])[0] or query.get("password", [None])[0]
    return user, password


async def on_connect(_message: dict, scope: dict) -> bool:
    user, password = ws_credentials(scope)
    if not user or not password or not verify_user(user, password):
        return True
    space_id = space_from_path(scope.get("path", ""))
    if space_id:
        mark_presence(space_id, user)
    return False


websocket_server = WebsocketServer()
app.mount("/ws", ASGIServer(websocket_server, on_connect=on_connect))
app.mount("/", StaticFiles(directory=ROOT_DIR, html=True), name="static")


async def main() -> None:
    config = uvicorn.Config(app, host="0.0.0.0", port=5000, log_level="info")
    server = uvicorn.Server(config)
    async with websocket_server:
        await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
