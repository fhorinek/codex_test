const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");

function resolveProjectRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "backend", "server.py");
    if (fssync.existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not locate project root from ${startDir}; backend/server.py not found`
      );
    }
    current = parent;
  }
}

const ROOT_DIR = resolveProjectRoot(__dirname);
const BACKEND_DIR = path.join(ROOT_DIR, "backend");
const USERS_FILE = path.join(BACKEND_DIR, "users_config.json");
const SESSIONS_FILE = path.join(BACKEND_DIR, "sessions.json");
const SPACES_DIR = path.join(BACKEND_DIR, "spaces");
const YSTORE_DIR = path.join(BACKEND_DIR, "ystore");
const SESSION_COOKIE_NAME = "task_session";

const ADMIN_USER = "qa_admin";
const MANAGER_USER = "qa_manager";
const USER_A = "qa_user_a";
const USER_B = "qa_user_b";
const ADMIN_PASS = "qa_admin_pass";
const MANAGER_PASS = "qa_manager_pass";
const USER_A_PASS = "qa_user_a_pass";
const USER_B_PASS = "qa_user_b_pass";

function md5Digest(password, salt) {
  return crypto
    .createHash("md5")
    .update(`${salt}:${password}`, "utf8")
    .digest("hex");
}

function makeUserRecord(displayName, role, password, salt, spaces = []) {
  return {
    display_name: displayName,
    role,
    spaces,
    password_salt: salt,
    password_hash: md5Digest(password, salt),
  };
}

function randomSpace(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreFile(filePath, previousContent) {
  if (previousContent === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, previousContent, "utf8");
}

async function backupAndResetDir(dirPath, backupPath) {
  await fs.rm(backupPath, { recursive: true, force: true });
  if (fssync.existsSync(dirPath)) {
    await fs.rename(dirPath, backupPath);
  }
  await fs.mkdir(dirPath, { recursive: true });
}

async function restoreDir(dirPath, backupPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
  if (fssync.existsSync(backupPath)) {
    await fs.rename(backupPath, dirPath);
  }
}

function getPythonExecutable() {
  const venvPython = path.join(BACKEND_DIR, ".venv", "bin", "python");
  return fssync.existsSync(venvPython) ? venvPython : "python3";
}

async function hasBindCapability() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Unable to resolve ephemeral port.")));
        return;
      }
      const { port } = address;
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl, serverProcess, getLogs, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess.exitCode !== null) {
      const logs = typeof getLogs === "function" ? getLogs() : "";
      throw new Error(
        `Server exited early with code ${serverProcess.exitCode}${
          logs ? `\nServer logs:\n${logs}` : ""
        }`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Received status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const logs = typeof getLogs === "function" ? getLogs() : "";
  throw new Error(
    `Timed out waiting for server at ${baseUrl}. Last error: ${
      lastError ? String(lastError) : "unknown"
    }${logs ? `\nServer logs:\n${logs}` : ""}`
  );
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }
  serverProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    delay(5000).then(() => {
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
      }
    }),
  ]);
}

function sessionCookieFromHeader(setCookieHeader) {
  const match = String(setCookieHeader || "").match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)
  );
  if (!match) {
    return "";
  }
  return `${SESSION_COOKIE_NAME}=${match[1]}`;
}

async function openAndCloseSpaceWebsocket(baseUrl, spaceId, username, password) {
  const wsBase = baseUrl.replace(/^http/i, "ws");
  const wsUrl = `${wsBase}/ws/${encodeURIComponent(spaceId)}?user=${encodeURIComponent(username)}&pass=${encodeURIComponent(password)}`;
  const python = getPythonExecutable();
  const script = `
import asyncio
import sys
import websockets

async def main():
    url = sys.argv[1]
    async with websockets.connect(url, open_timeout=10, close_timeout=10) as ws:
        try:
            await asyncio.wait_for(ws.recv(), timeout=1.0)
        except asyncio.TimeoutError:
            pass
        await asyncio.sleep(0.1)

asyncio.run(main())
`.trim();

  await new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", script, wsUrl], {
      cwd: BACKEND_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8000);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`websocket client exited with code ${code}${output ? `\n${output}` : ""}`));
    });
  });
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `login failed for ${username}`);
  const cookie = sessionCookieFromHeader(response.headers.get("set-cookie") || "");
  assert.ok(cookie, `missing cookie for ${username}`);
  return cookie;
}

function authHeaders(cookie, extra = {}) {
  return {
    cookie,
    ...extra,
  };
}

function findSpaceEntry(spacesPayload, spaceId) {
  return Array.isArray(spacesPayload?.spaces)
    ? spacesPayload.spaces.find((entry) => entry.id === spaceId)
    : null;
}

// End-to-end backend contract and permission matrix test.
// Covers:
// 1) API auth/login/me contract shapes and status codes.
// 2) Role-based access controls across users/spaces endpoints.
// 3) Space lifecycle edge cases (duplicate, invalid, rename conflict, delete missing).
// 4) Session last_space propagation on presence, rename and delete.
// 5) Collaboration presence visibility for multiple active users.
test("e2e: backend contracts, permissions, lifecycle and collaboration", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__backend_contract_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__backend_contract_backup__`;
  let serverProcess = null;

  try {
    const usersFixture = {
      users: {
        [ADMIN_USER]: makeUserRecord("QA Admin", "admin", ADMIN_PASS, "1000000000000001"),
        [MANAGER_USER]: makeUserRecord("QA Manager", "manager", MANAGER_PASS, "1000000000000002"),
        [USER_A]: makeUserRecord("QA User A", "user", USER_A_PASS, "1000000000000003"),
        [USER_B]: makeUserRecord("QA User B", "user", USER_B_PASS, "1000000000000004"),
      },
    };

    const port = await pickFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    await backupAndResetDir(SPACES_DIR, spacesBackup);
    await backupAndResetDir(YSTORE_DIR, ystoreBackup);
    await fs.writeFile(USERS_FILE, `${JSON.stringify(usersFixture, null, 2)}\n`, "utf8");
    await fs.writeFile(SESSIONS_FILE, `${JSON.stringify({ sessions: {} }, null, 2)}\n`, "utf8");

    serverProcess = spawn(getPythonExecutable(), ["server.py"], {
      cwd: BACKEND_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PORT: String(port),
      },
    });
    let logs = "";
    const appendLogs = (chunk) => {
      logs = `${logs}${String(chunk)}`.slice(-12000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);
    await waitForServer(baseUrl, serverProcess, () => logs);

    const adminCookie = await login(baseUrl, ADMIN_USER, ADMIN_PASS);
    const managerCookie = await login(baseUrl, MANAGER_USER, MANAGER_PASS);
    const userCookie = await login(baseUrl, USER_A, USER_A_PASS);

    // Verifies auth-related contract shape and status behavior.
    await t.test("auth contract and session invalidation", async () => {
      const unauthorizedMe = await fetch(`${baseUrl}/api/me`);
      assert.equal(unauthorizedMe.status, 401);

      const badLogin = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: ADMIN_USER, password: "wrong" }),
      });
      assert.equal(badLogin.status, 401);

      const meResponse = await fetch(`${baseUrl}/api/me`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(meResponse.status, 200);
      const mePayload = await meResponse.json();
      assert.equal(mePayload.user.username, ADMIN_USER);
      assert.equal(mePayload.user.role, "admin");
      assert.equal(typeof mePayload.permissions.can_manage_spaces, "boolean");
      assert.ok(Array.isArray(mePayload.spaces));
      assert.equal(typeof mePayload.last_space, "string");

      // Use a dedicated session for logout assertions so shared role-matrix sessions stay valid.
      const logoutProbeCookie = await login(baseUrl, USER_B, USER_B_PASS);
      const logoutResponse = await fetch(`${baseUrl}/api/logout`, {
        method: "POST",
        headers: authHeaders(logoutProbeCookie),
      });
      assert.equal(logoutResponse.status, 200);

      const meAfterLogout = await fetch(`${baseUrl}/api/me`, {
        headers: authHeaders(logoutProbeCookie),
      });
      assert.equal(meAfterLogout.status, 401);
    });

    // Verifies role-based permissions for spaces and user management endpoints.
    await t.test("role permission matrix", async () => {
      const adminSpace = randomSpace("role_space_admin");
      const managerSpace = randomSpace("role_space_manager");
      const userSpace = randomSpace("role_space_user");

      const adminCreate = await fetch(`${baseUrl}/api/spaces/${adminSpace}`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(adminCreate.status, 200);

      const managerCreate = await fetch(`${baseUrl}/api/spaces/${managerSpace}`, {
        method: "POST",
        headers: authHeaders(managerCookie),
      });
      assert.equal(managerCreate.status, 403);

      const userCreate = await fetch(`${baseUrl}/api/spaces/${userSpace}`, {
        method: "POST",
        headers: authHeaders(userCookie),
      });
      assert.equal(userCreate.status, 403);

      const adminUsers = await fetch(`${baseUrl}/api/users`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(adminUsers.status, 200);

      const managerUsers = await fetch(`${baseUrl}/api/users`, {
        headers: authHeaders(managerCookie),
      });
      assert.equal(managerUsers.status, 200);

      const userUsers = await fetch(`${baseUrl}/api/users`, {
        headers: authHeaders(userCookie),
      });
      assert.equal(userUsers.status, 403);

      const managerCreatesManager = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: authHeaders(managerCookie, { "content-type": "application/json" }),
        body: JSON.stringify({
          username: "qa_manager_created_manager",
          password: "temp_pass",
          role: "manager",
        }),
      });
      assert.equal(managerCreatesManager.status, 403);

      const managedUser = "qa_manager_created_user";
      const managerCreatesUser = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: authHeaders(managerCookie, { "content-type": "application/json" }),
        body: JSON.stringify({
          username: managedUser,
          password: "temp_pass",
          role: "user",
        }),
      });
      assert.equal(managerCreatesUser.status, 200);

      const managerDeletesUser = await fetch(`${baseUrl}/api/users/${managedUser}`, {
        method: "DELETE",
        headers: authHeaders(managerCookie),
      });
      assert.equal(managerDeletesUser.status, 200);
    });

    // Verifies important space lifecycle edge cases and response contracts.
    await t.test("space lifecycle edge-case contracts", async () => {
      const spaceA = randomSpace("lifecycle_a");
      const spaceB = randomSpace("lifecycle_b");
      const spaceC = randomSpace("lifecycle_c");

      const createA = await fetch(`${baseUrl}/api/spaces/${spaceA}`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(createA.status, 200);

      const duplicateA = await fetch(`${baseUrl}/api/spaces/${spaceA}`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(duplicateA.status, 409);

      const invalidId = await fetch(`${baseUrl}/api/spaces/bad%20id`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(invalidId.status, 400);

      const writeMissing = await fetch(`${baseUrl}/api/spaces/${spaceC}`, {
        method: "PUT",
        headers: authHeaders(adminCookie, { "content-type": "text/plain" }),
        body: "% Missing\n",
      });
      assert.equal(writeMissing.status, 404);

      const writeA = await fetch(`${baseUrl}/api/spaces/${spaceA}`, {
        method: "PUT",
        headers: authHeaders(adminCookie, { "content-type": "text/plain" }),
        body: "% Lifecycle\n!todo\n",
      });
      assert.equal(writeA.status, 200);

      const readA = await fetch(`${baseUrl}/api/spaces/${spaceA}`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(readA.status, 200);
      assert.equal(await readA.text(), "% Lifecycle\n!todo\n");

      const createB = await fetch(`${baseUrl}/api/spaces/${spaceB}`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(createB.status, 200);

      const renameConflict = await fetch(`${baseUrl}/api/spaces/${spaceA}/rename`, {
        method: "POST",
        headers: authHeaders(adminCookie, { "content-type": "application/json" }),
        body: JSON.stringify({ name: spaceB }),
      });
      assert.equal(renameConflict.status, 409);

      const renameA = await fetch(`${baseUrl}/api/spaces/${spaceA}/rename`, {
        method: "POST",
        headers: authHeaders(adminCookie, { "content-type": "application/json" }),
        body: JSON.stringify({ name: spaceC }),
      });
      assert.equal(renameA.status, 200);
      const renameData = await renameA.json();
      assert.equal(renameData.id, spaceC);

      const deleteMissing = await fetch(`${baseUrl}/api/spaces/${spaceA}`, {
        method: "DELETE",
        headers: authHeaders(adminCookie),
      });
      assert.equal(deleteMissing.status, 404);

      const deleteC = await fetch(`${baseUrl}/api/spaces/${spaceC}`, {
        method: "DELETE",
        headers: authHeaders(adminCookie),
      });
      assert.equal(deleteC.status, 200);

      const deleteB = await fetch(`${baseUrl}/api/spaces/${spaceB}`, {
        method: "DELETE",
        headers: authHeaders(adminCookie),
      });
      assert.equal(deleteB.status, 200);
    });

    // Verifies last_space session updates for presence, rename and delete events.
    await t.test("session last_space propagation", async () => {
      const sourceSpace = randomSpace("session_src");
      const renamedSpace = randomSpace("session_dst");

      const create = await fetch(`${baseUrl}/api/spaces/${sourceSpace}`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(create.status, 200);

      const presence = await fetch(`${baseUrl}/api/spaces/${sourceSpace}/presence`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(presence.status, 200);

      const meAfterPresence = await fetch(`${baseUrl}/api/me`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(meAfterPresence.status, 200);
      const mePresenceData = await meAfterPresence.json();
      assert.equal(mePresenceData.last_space, sourceSpace);

      const rename = await fetch(`${baseUrl}/api/spaces/${sourceSpace}/rename`, {
        method: "POST",
        headers: authHeaders(adminCookie, { "content-type": "application/json" }),
        body: JSON.stringify({ name: renamedSpace }),
      });
      assert.equal(rename.status, 200);

      const meAfterRename = await fetch(`${baseUrl}/api/me`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(meAfterRename.status, 200);
      const meRenameData = await meAfterRename.json();
      assert.equal(meRenameData.last_space, renamedSpace);

      const remove = await fetch(`${baseUrl}/api/spaces/${renamedSpace}`, {
        method: "DELETE",
        headers: authHeaders(adminCookie),
      });
      assert.equal(remove.status, 200);

      const meAfterDelete = await fetch(`${baseUrl}/api/me`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(meAfterDelete.status, 200);
      const meDeleteData = await meAfterDelete.json();
      assert.equal(meDeleteData.last_space, "");
    });

    // Verifies collaboration presence visibility with two active users in the same space.
    await t.test("presence visibility and cleanup across users", async () => {
      const collabSpace = randomSpace("collab");

      const create = await fetch(`${baseUrl}/api/spaces/${collabSpace}`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(create.status, 200);

      const adminPresence = await fetch(`${baseUrl}/api/spaces/${collabSpace}/presence`, {
        method: "POST",
        headers: authHeaders(adminCookie),
      });
      assert.equal(adminPresence.status, 200);

      const managerPresence = await fetch(`${baseUrl}/api/spaces/${collabSpace}/presence`, {
        method: "POST",
        headers: authHeaders(managerCookie),
      });
      assert.equal(managerPresence.status, 200);

      const listWithTwo = await fetch(`${baseUrl}/api/spaces`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(listWithTwo.status, 200);
      const withTwoData = await listWithTwo.json();
      const withTwoEntry = findSpaceEntry(withTwoData, collabSpace);
      assert.ok(withTwoEntry, "expected collab space in listing");
      assert.deepEqual(withTwoEntry.users, [ADMIN_USER, MANAGER_USER].sort());

      const managerPresenceClear = await fetch(`${baseUrl}/api/spaces/${collabSpace}/presence`, {
        method: "DELETE",
        headers: authHeaders(managerCookie),
      });
      assert.equal(managerPresenceClear.status, 200);

      const listWithAdminOnly = await fetch(`${baseUrl}/api/spaces`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(listWithAdminOnly.status, 200);
      const adminOnlyData = await listWithAdminOnly.json();
      const adminOnlyEntry = findSpaceEntry(adminOnlyData, collabSpace);
      assert.ok(adminOnlyEntry, "expected collab space in listing");
      assert.deepEqual(adminOnlyEntry.users, [ADMIN_USER]);

      const adminPresenceClear = await fetch(`${baseUrl}/api/spaces/${collabSpace}/presence`, {
        method: "DELETE",
        headers: authHeaders(adminCookie),
      });
      assert.equal(adminPresenceClear.status, 200);

      const listWithNoPresence = await fetch(`${baseUrl}/api/spaces`, {
        headers: authHeaders(adminCookie),
      });
      assert.equal(listWithNoPresence.status, 200);
      const noPresenceData = await listWithNoPresence.json();
      const noPresenceEntry = findSpaceEntry(noPresenceData, collabSpace);
      assert.ok(noPresenceEntry, "expected collab space in listing");
      assert.deepEqual(noPresenceEntry.users, []);

      const deleteSpace = await fetch(`${baseUrl}/api/spaces/${collabSpace}`, {
        method: "DELETE",
        headers: authHeaders(adminCookie),
      });
      assert.equal(deleteSpace.status, 200);
    });
  } finally {
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});

// Regression: normal websocket client disconnects should not surface as fatal
// ExceptionGroup traces during backend shutdown.
test("e2e: websocket disconnect does not crash backend on shutdown", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__ws_disconnect_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__ws_disconnect_backup__`;
  let serverProcess = null;
  let logs = "";

  try {
    const usersFixture = {
      users: {
        [ADMIN_USER]: makeUserRecord("QA Admin", "admin", ADMIN_PASS, "1000000000000001"),
      },
    };

    const port = await pickFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsSpace = randomSpace("ws_disconnect");

    await backupAndResetDir(SPACES_DIR, spacesBackup);
    await backupAndResetDir(YSTORE_DIR, ystoreBackup);
    await fs.writeFile(USERS_FILE, `${JSON.stringify(usersFixture, null, 2)}\n`, "utf8");
    await fs.writeFile(SESSIONS_FILE, `${JSON.stringify({ sessions: {} }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(SPACES_DIR, `${wsSpace}.txt`), "Board Name: WS Disconnect\n\n% Seeded\n", "utf8");

    serverProcess = spawn(getPythonExecutable(), ["server.py"], {
      cwd: BACKEND_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PORT: String(port),
      },
    });
    const appendLogs = (chunk) => {
      logs = `${logs}${String(chunk)}`.slice(-50000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);

    await waitForServer(baseUrl, serverProcess, () => logs);

    // Connect/disconnect more than once to exercise room send/close race paths.
    await openAndCloseSpaceWebsocket(baseUrl, wsSpace, ADMIN_USER, ADMIN_PASS);
    await openAndCloseSpaceWebsocket(baseUrl, wsSpace, ADMIN_USER, ADMIN_PASS);

    assert.equal(serverProcess.exitCode, null, "server should remain running after websocket disconnect");
    const health = await fetch(`${baseUrl}/`);
    assert.equal(health.status, 200);

    await stopServer(serverProcess);
    serverProcess = null;

    assert.doesNotMatch(logs, /ExceptionGroup: unhandled errors in a TaskGroup/);
    assert.doesNotMatch(logs, /ERROR:\s+Exception in ASGI application/);
  } finally {
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});
