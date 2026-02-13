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
const E2E_USERNAME = "e2e_admin";
const E2E_PASSWORD = "e2e_password";
const E2E_SALT = "0011223344556677";

function md5Digest(password, salt) {
  return crypto
    .createHash("md5")
    .update(`${salt}:${password}`, "utf8")
    .digest("hex");
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

function getPythonExecutable() {
  const venvPython = path.join(BACKEND_DIR, ".venv", "bin", "python");
  return fssync.existsSync(venvPython) ? venvPython : "python3";
}

async function waitForServer(baseUrl, serverProcess, getLogs, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess.exitCode !== null) {
      const logs = typeof getLogs === "function" ? getLogs() : "";
      const debugOutput = (logs && logs.length ? `\nServer logs:\n${logs}` : "");
      throw new Error(
        `Server exited early with code ${serverProcess.exitCode}${debugOutput}`
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
    }${logs && logs.length ? `\nServer logs:\n${logs}` : ""}`
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

// End-to-end backend + app contract test.
// Sequence covered in a single flow:
// 1) Start backend on an ephemeral port with isolated spaces/ystore fixtures.
// 2) Verify app shell is served and contains key editor/modal anchors.
// 3) Verify unauthorized /api/me is rejected.
// 4) Verify login failure path and login success path.
// 5) Verify authenticated /api/me user payload values.
// 6) Verify space lifecycle: create -> update text -> read text -> list presence -> delete.
// 7) Always restore original backend files/directories (users, sessions, spaces, ystore).
test("e2e: app shell, auth flow, and space CRUD work end-to-end", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }
  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__e2e_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__e2e_backup__`;
  let serverProcess = null;

  const usersFixture = {
    users: {
      [E2E_USERNAME]: {
        display_name: "E2E Admin",
        role: "admin",
        spaces: [],
        password_salt: E2E_SALT,
        password_hash: md5Digest(E2E_PASSWORD, E2E_SALT),
      },
    },
  };

  try {
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

    const indexResponse = await fetch(`${baseUrl}/`);
    assert.equal(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /id="code-editor"/);
    assert.match(indexHtml, /id="task-edit-modal"/);

    const unauthorizedMe = await fetch(`${baseUrl}/api/me`);
    assert.equal(unauthorizedMe.status, 401);

    const badLoginResponse = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: E2E_USERNAME, password: "wrong" }),
    });
    assert.equal(badLoginResponse.status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: E2E_USERNAME, password: E2E_PASSWORD }),
    });
    assert.equal(loginResponse.status, 200);
    const setCookie = loginResponse.headers.get("set-cookie") || "";
    const sessionCookie = sessionCookieFromHeader(setCookie);
    assert.ok(sessionCookie, "expected login to return a session cookie");

    const meResponse = await fetch(`${baseUrl}/api/me`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(meResponse.status, 200);
    const meData = await meResponse.json();
    const meUser = meData && typeof meData === "object" ? (meData.user || meData) : {};
    assert.equal(meUser.username, E2E_USERNAME);
    assert.equal(meUser.role, "admin");

    const createdSpaceId = `e2e_space_${Date.now()}`;

    const createSpaceResponse = await fetch(`${baseUrl}/api/spaces/${createdSpaceId}`, {
      method: "POST",
      headers: { cookie: sessionCookie },
    });
    assert.equal(createSpaceResponse.status, 200);

    const updateSpaceResponse = await fetch(`${baseUrl}/api/spaces/${createdSpaceId}`, {
      method: "PUT",
      headers: {
        cookie: sessionCookie,
        "content-type": "text/plain",
      },
      body: "% E2E\n!todo\n",
    });
    assert.equal(updateSpaceResponse.status, 200);

    const openSpaceResponse = await fetch(`${baseUrl}/api/spaces/${createdSpaceId}`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(openSpaceResponse.status, 200);
    const openSpaceText = await openSpaceResponse.text();
    assert.equal(openSpaceText, "% E2E\n!todo\n");

    const spacesResponse = await fetch(`${baseUrl}/api/spaces`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(spacesResponse.status, 200);
    const spacesData = await spacesResponse.json();
    assert.ok(
      Array.isArray(spacesData.spaces)
      && spacesData.spaces.some((space) => space.id === createdSpaceId),
      "expected spaces list to include created space"
    );

    const deleteSpaceResponse = await fetch(`${baseUrl}/api/spaces/${createdSpaceId}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie },
    });
    assert.equal(deleteSpaceResponse.status, 200);
  } finally {
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});
