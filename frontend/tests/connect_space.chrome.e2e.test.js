const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium, expect } = require("@playwright/test");

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
const CHROME_PATH = process.env.GOOGLE_CHROME_BIN || "/usr/bin/google-chrome";
const ARTIFACTS_ROOT = path.join(ROOT_DIR, "frontend", "test-artifacts", "connect-space-chrome");

const E2E_USERNAME = "e2e_admin";
const E2E_PASSWORD = "e2e_password";
const E2E_SALT = "0011223344556677";
const E2E_USERNAME_2 = "e2e_user_two";
const E2E_PASSWORD_2 = "e2e_password_two";
const E2E_SALT_2 = "8899aabbccddeeff";
const SPACE_ID = "dup_regression_space";
const SPACE_CONTENT = [
  "Board Name: Dup Regression",
  "",
  "% Existing task",
  "!todo ~3 @maya #backend",
  "This content already exists before connect.",
].join("\n");

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
      throw new Error(
        `Server exited early with code ${serverProcess.exitCode}${logs ? `\n${logs}` : ""}`
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
    `Timed out waiting for server at ${baseUrl}: ${lastError ? String(lastError) : "unknown"}${logs ? `\n${logs}` : ""
    }`
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

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeArtifact(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function attachPageLogCollectors(page, browserLogs) {
  page.on("console", (msg) => {
    browserLogs.push(`[console:${msg.type()}] ${msg.text()}`);
    if (browserLogs.length > 80) {
      browserLogs.shift();
    }
  });
  page.on("pageerror", (error) => {
    browserLogs.push(`[pageerror] ${error?.message || String(error)}`);
    if (browserLogs.length > 80) {
      browserLogs.shift();
    }
  });
}

async function loginAndConnectToSpace({
  page,
  baseUrl,
  username,
  password,
  spaceId,
  artifactsDir,
  screenshotPrefix,
  screenshotNamer,
}) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#connect-button").click();
  await expect(page.locator("#login-modal")).toBeVisible();
  if (artifactsDir) {
    const fileName = screenshotNamer
      ? screenshotNamer(`${screenshotPrefix}-login-modal.png`)
      : `${screenshotPrefix}-login-modal.png`;
    await fs.mkdir(artifactsDir, { recursive: true });
    await page.screenshot({
      path: path.join(artifactsDir, fileName),
      fullPage: true,
    });
  }

  await page.fill("#login-username", username);
  await page.fill("#login-password", password);
  await page.click("#login-submit");

  await expect(page.locator("#spaces-modal")).toBeVisible();
  const row = page.locator(".space-item", { hasText: spaceId }).first();
  await expect(row).toBeVisible();
  if (artifactsDir) {
    const fileName = screenshotNamer
      ? screenshotNamer(`${screenshotPrefix}-spaces-modal.png`)
      : `${screenshotPrefix}-spaces-modal.png`;
    await page.screenshot({
      path: path.join(artifactsDir, fileName),
      fullPage: true,
    });
  }
  await row.locator(".space-connect").click();

  await expect(page.locator("#spaces-modal")).toBeHidden();
  await expect.poll(async () => {
    const text = await page.locator("#board-connection").textContent();
    return text || "";
  }).toContain(spaceId);

  await expect.poll(async () => page.locator("#task-editor").evaluate((el) => el.value), {
    timeout: 10000,
  }).toBe(`${SPACE_CONTENT}\n`);

  if (artifactsDir) {
    const fileName = screenshotNamer
      ? screenshotNamer(`${screenshotPrefix}-connected.png`)
      : `${screenshotPrefix}-connected.png`;
    await page.screenshot({
      path: path.join(artifactsDir, fileName),
      fullPage: true,
    });
  }
}

async function getEditorValue(page) {
  return page.locator("#task-editor").evaluate((el) => el.value);
}

async function logoutViaSpacesModal(page) {
  await page.locator("#connect-button").click();
  await expect(page.locator("#spaces-modal")).toBeVisible();
  await page.locator("#spaces-logout").click();
  await expect(page.locator("#profile-logout-modal")).toBeVisible();
  await page.locator("#profile-logout-confirm").click();
  await expect(page.locator("#login-modal")).toBeVisible();
}

async function setEditorSelection(page, start, end) {
  await page.evaluate(async (range) => {
    const hooks = window.__taskScriptTestHooks;
    if (hooks?.setEditorSelectionRange) {
      hooks.setEditorSelectionRange(range.start, range.end);
      hooks.syncEditorOverlayMetrics?.();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return;
    }
    const el = document.querySelector("#task-editor");
    if (!el) {
      return;
    }
    el.focus();
    el.setSelectionRange(range.start, range.end, "forward");
    el.dispatchEvent(new Event("mouseup", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }));
  }, { start, end });
}

async function getVisibleSourceEditorDisplayRects(page) {
  return page.evaluate(() => {
    const hooks = window.__taskScriptTestHooks;
    if (!hooks?.getEditorDisplayRects) {
      return { selection: [], cursor: [] };
    }
    const rects = hooks.getEditorDisplayRects();
    return {
      selection: Array.isArray(rects?.selection) ? rects.selection : [],
      cursor: Array.isArray(rects?.cursor) ? rects.cursor : [],
    };
  });
}

async function getVisibleRemoteOverlays(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const toRect = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    const uniqueElements = (selectors) => {
      const seen = new Set();
      const result = [];
      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el);
            result.push(el);
          }
        });
      });
      return result;
    };
    const selectionSelectors = [
      ".selectedText", // y-textarea legacy
      ".cm-ySelection",
      ".cm-ySelectionCaret",
      ".cm-ySelectionHead",
      ".yRemoteSelection",
      ".yRemoteSelectionHead",
    ];
    const nameSelectors = [
      ".nameTag", // y-textarea legacy
      ".cm-ySelectionInfo",
      ".yRemoteSelectionInfo",
    ];
    return {
      selections: uniqueElements(selectionSelectors)
        .filter(visible)
        .map((el) => ({
          rect: toRect(el),
          text: el.textContent || "",
          className: el.className || "",
          background: window.getComputedStyle(el).backgroundColor,
        })),
      names: uniqueElements(nameSelectors)
        .filter(visible)
        .map((el) => ({
          rect: toRect(el),
          text: (el.textContent || "").trim(),
          className: el.className || "",
        })),
    };
  });
}

async function getExpectedRemoteOverlayRect(page, start, end) {
  return page.locator("#task-editor").evaluate(
    (textField, range) => {
      const overlap = (a, b) => {
        const x1 = Math.max(a.x, b.x);
        const x2 = Math.min(a.x + a.width, b.x + b.width);
        if (x2 < x1) return null;
        const y1 = Math.max(a.y, b.y);
        const y2 = Math.min(a.y + a.height, b.y + b.height);
        if (y2 < y1) return null;
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      };

      const getCaretCoordinates = (element, position) => {
        const properties = [
          "direction",
          "boxSizing",
          "width",
          "height",
          "overflowX",
          "overflowY",
          "borderTopWidth",
          "borderRightWidth",
          "borderBottomWidth",
          "borderLeftWidth",
          "borderStyle",
          "paddingTop",
          "paddingRight",
          "paddingBottom",
          "paddingLeft",
          "fontStyle",
          "fontVariant",
          "fontWeight",
          "fontStretch",
          "fontSize",
          "fontSizeAdjust",
          "lineHeight",
          "fontFamily",
          "textAlign",
          "textTransform",
          "textIndent",
          "textDecoration",
          "letterSpacing",
          "wordSpacing",
          "tabSize",
          "MozTabSize",
        ];
        const div = document.createElement("div");
        document.body.appendChild(div);
        const style = div.style;
        const computed = window.getComputedStyle(element);
        style.whiteSpace = "pre-wrap";
        style.wordWrap = "break-word";
        style.position = "absolute";
        style.visibility = "hidden";
        properties.forEach((prop) => {
          style[prop] = computed[prop];
        });
        style.overflow = "hidden";
        div.textContent = element.value.substring(0, position);
        const span = document.createElement("span");
        span.textContent = element.value.substring(position) || ".";
        div.appendChild(span);
        const coordinates = {
          top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
          left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
        };
        document.body.removeChild(div);
        return coordinates;
      };

      const safeStart = Math.max(0, Math.min(range.start, textField.value.length));
      const safeEnd = Math.max(0, Math.min(range.end, textField.value.length));
      const startCoords = getCaretCoordinates(textField, safeStart);
      const endCoords = getCaretCoordinates(textField, safeEnd);
      let width = 1;
      let heightDelta = 0;
      if (safeStart !== safeEnd) {
        width = endCoords.left - startCoords.left;
        heightDelta = endCoords.top - startCoords.top;
        if (heightDelta !== 0) {
          width = 1;
        }
      }
      const textareaRect = textField.getBoundingClientRect();
      const fontSize = parseInt(window.getComputedStyle(textField).fontSize, 10) || 16;
      const cursorRect = {
        x: textareaRect.left - textField.scrollLeft + startCoords.left,
        y: textareaRect.top - textField.scrollTop + startCoords.top,
        width,
        height: fontSize,
      };
      const areaRect = {
        x: textareaRect.left,
        y: textareaRect.top,
        width: textField.clientWidth,
        height: textField.clientHeight,
      };
      return overlap(areaRect, cursorRect);
    },
    { start, end }
  );
}

function assertRectClose(actual, expected, label, tolerancePx = 4) {
  assert.ok(actual, `${label}: actual rect missing`);
  assert.ok(expected, `${label}: expected rect missing`);
  for (const key of ["x", "y", "width", "height"]) {
    const delta = Math.abs(actual[key] - expected[key]);
    assert.ok(
      delta <= tolerancePx,
      `${label}: ${key} differs too much (actual=${actual[key]}, expected=${expected[key]}, delta=${delta}, tolerance=${tolerancePx})`
    );
  }
}

function buildScreenshotClipAroundRect(page, rect, padding = 24) {
  assert.ok(rect, "screenshot clip source rect is required");
  const viewport = page.viewportSize();
  assert.ok(viewport, "page viewport size unavailable");

  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  return { x, y, width, height };
}

function assertImageBuffersEqual(actual, expected, label) {
  assert.ok(Buffer.isBuffer(actual), `${label}: actual image buffer missing`);
  assert.ok(Buffer.isBuffer(expected), `${label}: expected image buffer missing`);
  if (Buffer.compare(actual, expected) === 0) {
    return;
  }
  const minLength = Math.min(actual.length, expected.length);
  let firstDiffIndex = -1;
  for (let i = 0; i < minLength; i += 1) {
    if (actual[i] !== expected[i]) {
      firstDiffIndex = i;
      break;
    }
  }
  assert.fail(
    `${label}: clipped screenshots differ (actual=${actual.length} bytes, expected=${expected.length} bytes, firstDiffIndex=${firstDiffIndex})`
  );
}

async function createPngDiffArtifact(page, beforeBuffer, afterBuffer) {
  assert.ok(Buffer.isBuffer(beforeBuffer), "beforeBuffer must be a Buffer");
  assert.ok(Buffer.isBuffer(afterBuffer), "afterBuffer must be a Buffer");
  const result = await page.evaluate(
    async ({ beforeBase64, afterBase64 }) => {
      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("Failed to decode PNG screenshot."));
          image.src = src;
        });

      const beforeImage = await loadImage(`data:image/png;base64,${beforeBase64}`);
      const afterImage = await loadImage(`data:image/png;base64,${afterBase64}`);
      if (
        beforeImage.naturalWidth !== afterImage.naturalWidth ||
        beforeImage.naturalHeight !== afterImage.naturalHeight
      ) {
        throw new Error(
          `Screenshot dimensions differ (${beforeImage.naturalWidth}x${beforeImage.naturalHeight} vs ${afterImage.naturalWidth}x${afterImage.naturalHeight})`
        );
      }

      const width = beforeImage.naturalWidth;
      const height = beforeImage.naturalHeight;
      const beforeCanvas = document.createElement("canvas");
      beforeCanvas.width = width;
      beforeCanvas.height = height;
      const afterCanvas = document.createElement("canvas");
      afterCanvas.width = width;
      afterCanvas.height = height;
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = width;
      diffCanvas.height = height;

      const beforeCtx = beforeCanvas.getContext("2d");
      const afterCtx = afterCanvas.getContext("2d");
      const diffCtx = diffCanvas.getContext("2d");
      if (!beforeCtx || !afterCtx || !diffCtx) {
        throw new Error("Canvas 2D context unavailable for image diff generation.");
      }

      beforeCtx.drawImage(beforeImage, 0, 0);
      afterCtx.drawImage(afterImage, 0, 0);

      const beforeData = beforeCtx.getImageData(0, 0, width, height);
      const afterData = afterCtx.getImageData(0, 0, width, height);
      const diffData = diffCtx.createImageData(width, height);

      let changedPixels = 0;
      for (let i = 0; i < beforeData.data.length; i += 4) {
        const r1 = beforeData.data[i];
        const g1 = beforeData.data[i + 1];
        const b1 = beforeData.data[i + 2];
        const a1 = beforeData.data[i + 3];
        const r2 = afterData.data[i];
        const g2 = afterData.data[i + 1];
        const b2 = afterData.data[i + 2];
        const a2 = afterData.data[i + 3];

        const changed = r1 !== r2 || g1 !== g2 || b1 !== b2 || a1 !== a2;
        if (changed) {
          changedPixels += 1;
          diffData.data[i] = 255; // red highlight
          diffData.data[i + 1] = 0;
          diffData.data[i + 2] = 0;
          diffData.data[i + 3] = 255;
        } else {
          const luminance = Math.round((r1 + g1 + b1) / 3);
          diffData.data[i] = luminance;
          diffData.data[i + 1] = luminance;
          diffData.data[i + 2] = luminance;
          diffData.data[i + 3] = Math.max(24, Math.min(160, a1));
        }
      }

      diffCtx.putImageData(diffData, 0, 0);
      const dataUrl = diffCanvas.toDataURL("image/png");
      return { width, height, changedPixels, dataUrl };
    },
    {
      beforeBase64: beforeBuffer.toString("base64"),
      afterBase64: afterBuffer.toString("base64"),
    }
  );

  return {
    width: result.width,
    height: result.height,
    changedPixels: result.changedPixels,
    buffer: Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
  };
}

function createScreenshotNamer() {
  let step = 1;
  return (baseName) => `${String(step++).padStart(2, "0")}-${baseName}`;
}

function assertSeededContentNotDuplicated(value, label) {
  assert.equal(value, `${SPACE_CONTENT}\n`, `${label}: editor value should exactly match seeded content`);
  assert.equal(
    value.split("This content already exists before connect.").length - 1,
    1,
    `${label}: seeded content marker should appear exactly once`
  );
}

test("chrome e2e: connecting to preloaded space does not duplicate editor content", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }
  if (!fssync.existsSync(CHROME_PATH)) {
    t.skip(`Chrome not found at ${CHROME_PATH}`);
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__chrome_e2e_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__chrome_e2e_backup__`;
  let serverProcess = null;
  let browser = null;
  let context = null;
  let page = null;
  let serverLogs = "";
  const browserLogs = [];
  const runArtifactsDir = path.join(ARTIFACTS_ROOT, timestampSlug());

  const usersFixture = {
    users: {
      [E2E_USERNAME]: {
        display_name: "E2E Admin",
        role: "admin",
        spaces: [],
        must_change_password: false,
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
    await fs.writeFile(path.join(SPACES_DIR, `${SPACE_ID}.txt`), `${SPACE_CONTENT}\n`, "utf8");

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
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-16000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);

    await waitForServer(baseUrl, serverProcess, () => serverLogs);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true
    });
    context = await browser.newContext();
    page = await context.newPage();
    page.on("console", (msg) => {
      browserLogs.push(`[console:${msg.type()}] ${msg.text()}`);
      if (browserLogs.length > 50) {
        browserLogs.shift();
      }
    });
    page.on("pageerror", (error) => {
      browserLogs.push(`[pageerror] ${error?.message || String(error)}`);
      if (browserLogs.length > 50) {
        browserLogs.shift();
      }
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#connect-button").click();
    await expect(page.locator("#login-modal")).toBeVisible();
    await fs.mkdir(runArtifactsDir, { recursive: true });
    await page.screenshot({ path: path.join(runArtifactsDir, "01-login-modal.png"), fullPage: true });

    await page.fill("#login-username", E2E_USERNAME);
    await page.fill("#login-password", E2E_PASSWORD);
    await page.click("#login-submit");

    await expect(page.locator("#spaces-modal")).toBeVisible();
    await page.screenshot({ path: path.join(runArtifactsDir, "02-spaces-modal.png"), fullPage: true });
    const row = page.locator(".space-item", { hasText: SPACE_ID }).first();
    await expect(row).toBeVisible();
    await row.locator(".space-connect").click();

    await expect(page.locator("#spaces-modal")).toBeHidden();
    await expect.poll(async () => {
      const text = await page.locator("#board-connection").textContent();
      return text || "";
    }).toContain(SPACE_ID);

    await expect.poll(async () => page.locator("#task-editor").evaluate((el) => el.value), {
      timeout: 10000,
    }).toBe(`${SPACE_CONTENT}\n`);
    await page.screenshot({ path: path.join(runArtifactsDir, "03-connected.png"), fullPage: true });

    // Re-check after sync settles; if the old bug regresses, content often becomes duplicated.
    await page.waitForTimeout(1000);
    const finalValue = await page.locator("#task-editor").evaluate((el) => el.value);
    assert.equal(finalValue, `${SPACE_CONTENT}\n`);
    assert.equal(
      finalValue.split("This content already exists before connect.").length - 1,
      1,
      "seeded content marker should appear exactly once"
    );

    await writeArtifact(path.join(runArtifactsDir, "browser.log"), `${browserLogs.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
    await writeArtifact(path.join(runArtifactsDir, "editor.txt"), finalValue);
    console.log(`Artifacts saved to ${runArtifactsDir}`);
  } catch (error) {
    try {
      await fs.mkdir(runArtifactsDir, { recursive: true });
      if (page) {
        await page.screenshot({
          path: path.join(runArtifactsDir, "failure.png"),
          fullPage: true,
        });
      }
      await writeArtifact(path.join(runArtifactsDir, "browser.log"), `${browserLogs.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
      console.log(`Failure artifacts saved to ${runArtifactsDir}`);
    } catch {
      // Ignore artifact write failures.
    }
    if (error instanceof Error) {
      error.message = `${error.message}\n(Test: preloaded space connect no-dup regression)`;
    }
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => { });
    }
    if (browser) {
      await browser.close().catch(() => { });
    }
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});

test("chrome e2e: second user connecting to same space does not duplicate content", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }
  if (!fssync.existsSync(CHROME_PATH)) {
    t.skip(`Chrome not found at ${CHROME_PATH}`);
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__chrome_e2e_multi_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__chrome_e2e_multi_backup__`;
  let serverProcess = null;
  let browser = null;
  let context1 = null;
  let context2 = null;
  let page1 = null;
  let page2 = null;
  let serverLogs = "";
  const browserLogs1 = [];
  const browserLogs2 = [];
  const runArtifactsDir = path.join(ARTIFACTS_ROOT, `${timestampSlug()}-two-users`);

  const usersFixture = {
    users: {
      [E2E_USERNAME]: {
        display_name: "E2E Admin",
        role: "admin",
        spaces: [],
        must_change_password: false,
        password_salt: E2E_SALT,
        password_hash: md5Digest(E2E_PASSWORD, E2E_SALT),
      },
      [E2E_USERNAME_2]: {
        display_name: "E2E User Two",
        role: "admin",
        spaces: [],
        must_change_password: false,
        password_salt: E2E_SALT_2,
        password_hash: md5Digest(E2E_PASSWORD_2, E2E_SALT_2),
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
    await fs.writeFile(path.join(SPACES_DIR, `${SPACE_ID}.txt`), `${SPACE_CONTENT}\n`, "utf8");

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
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-24000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);

    await waitForServer(baseUrl, serverProcess, () => serverLogs);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    context1 = await browser.newContext();
    page1 = await context1.newPage();
    attachPageLogCollectors(page1, browserLogs1);

    await loginAndConnectToSpace({
      page: page1,
      baseUrl,
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "user1",
    });

    const user1Initial = await getEditorValue(page1);
    assertSeededContentNotDuplicated(user1Initial, "user1 initial");

    context2 = await browser.newContext();
    page2 = await context2.newPage();
    attachPageLogCollectors(page2, browserLogs2);

    await loginAndConnectToSpace({
      page: page2,
      baseUrl,
      username: E2E_USERNAME_2,
      password: E2E_PASSWORD_2,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "user2",
    });

    // Allow presence/sync events to settle after the second user joins.
    await page1.waitForTimeout(1200);
    const user1Final = await getEditorValue(page1);
    const user2Final = await getEditorValue(page2);
    assertSeededContentNotDuplicated(user1Final, "user1 final");
    assertSeededContentNotDuplicated(user2Final, "user2 final");

    await writeArtifact(path.join(runArtifactsDir, "browser-user1.log"), `${browserLogs1.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "browser-user2.log"), `${browserLogs2.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
    await writeArtifact(path.join(runArtifactsDir, "editor-user1.txt"), user1Final);
    await writeArtifact(path.join(runArtifactsDir, "editor-user2.txt"), user2Final);
    console.log(`Artifacts saved to ${runArtifactsDir}`);
  } catch (error) {
    try {
      await fs.mkdir(runArtifactsDir, { recursive: true });
      if (page1) {
        await page1.screenshot({
          path: path.join(runArtifactsDir, "failure-user1.png"),
          fullPage: true,
        });
      }
      if (page2) {
        await page2.screenshot({
          path: path.join(runArtifactsDir, "failure-user2.png"),
          fullPage: true,
        });
      }
      await writeArtifact(path.join(runArtifactsDir, "browser-user1.log"), `${browserLogs1.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "browser-user2.log"), `${browserLogs2.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
      console.log(`Failure artifacts saved to ${runArtifactsDir}`);
    } catch {
      // Ignore artifact write failures.
    }
    if (error instanceof Error) {
      error.message = `${error.message}\n(Test: second user connect no-dup regression)`;
    }
    throw error;
  } finally {
    if (context1) {
      await context1.close().catch(() => { });
    }
    if (context2) {
      await context2.close().catch(() => { });
    }
    if (browser) {
      await browser.close().catch(() => { });
    }
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});

test("chrome e2e: logout does not call legacy /presence endpoint (awareness-driven presence)", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }
  if (!fssync.existsSync(CHROME_PATH)) {
    t.skip(`Chrome not found at ${CHROME_PATH}`);
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__chrome_e2e_logout_presence_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__chrome_e2e_logout_presence_backup__`;
  let serverProcess = null;
  let browser = null;
  let context = null;
  let page = null;
  let serverLogs = "";
  const browserLogs = [];
  const runArtifactsDir = path.join(ARTIFACTS_ROOT, `${timestampSlug()}-logout-presence`);

  const usersFixture = {
    users: {
      [E2E_USERNAME]: {
        display_name: "E2E Admin",
        role: "admin",
        spaces: [],
        must_change_password: false,
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
    await fs.writeFile(path.join(SPACES_DIR, `${SPACE_ID}.txt`), `${SPACE_CONTENT}\n`, "utf8");

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
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-40000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);

    await waitForServer(baseUrl, serverProcess, () => serverLogs);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });
    context = await browser.newContext();
    page = await context.newPage();
    attachPageLogCollectors(page, browserLogs);

    await loginAndConnectToSpace({
      page,
      baseUrl,
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "logout-presence",
    });

    await logoutViaSpacesModal(page);
    await page.waitForTimeout(800);

    const anyPresenceEndpoint = `/api/spaces/${SPACE_ID}/presence HTTP/1.1"`;
    const presenceDelete401 = `DELETE /api/spaces/${SPACE_ID}/presence HTTP/1.1" 401`;
    const presencePost = `POST /api/spaces/${SPACE_ID}/presence HTTP/1.1"`;
    assert.equal(
      serverLogs.includes(anyPresenceEndpoint),
      false,
      "legacy presence endpoint should not be called when presence is awareness-driven"
    );
    assert.equal(
      serverLogs.includes(presenceDelete401),
      false,
      "legacy presence delete should not return 401 after logout"
    );
    assert.equal(
      serverLogs.includes(presencePost),
      false,
      "legacy presence heartbeat POST should not be sent"
    );

    await fs.mkdir(runArtifactsDir, { recursive: true });
    await page.screenshot({
      path: path.join(runArtifactsDir, "logout-presence-after-logout.png"),
      fullPage: true,
    });
    await writeArtifact(path.join(runArtifactsDir, "browser.log"), `${browserLogs.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
    console.log(`Artifacts saved to ${runArtifactsDir}`);
  } catch (error) {
    try {
      await fs.mkdir(runArtifactsDir, { recursive: true });
      if (page) {
        await page.screenshot({
          path: path.join(runArtifactsDir, "failure.png"),
          fullPage: true,
        });
      }
      await writeArtifact(path.join(runArtifactsDir, "browser.log"), `${browserLogs.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
      console.log(`Failure artifacts saved to ${runArtifactsDir}`);
    } catch {
      // Ignore artifact write failures.
    }
    if (error instanceof Error) {
      error.message = `${error.message}\n(Test: logout should not call legacy /presence endpoint)`;
    }
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => { });
    }
    if (browser) {
      await browser.close().catch(() => { });
    }
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});

test("chrome e2e: user2 click does not move user1 remote cursor to line 0 char 0", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }
  if (!fssync.existsSync(CHROME_PATH)) {
    t.skip(`Chrome not found at ${CHROME_PATH}`);
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__chrome_e2e_click_cursor_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__chrome_e2e_click_cursor_backup__`;
  let serverProcess = null;
  let browser = null;
  let context1 = null;
  let context2 = null;
  let page1 = null;
  let page2 = null;
  let serverLogs = "";
  const browserLogs1 = [];
  const browserLogs2 = [];
  const runArtifactsDir = path.join(ARTIFACTS_ROOT, `${timestampSlug()}-click-cursor-regression`);
  const nextScreenshotName = createScreenshotNamer();

  const usersFixture = {
    users: {
      [E2E_USERNAME]: {
        display_name: "E2E Admin",
        role: "admin",
        spaces: [],
        must_change_password: false,
        password_salt: E2E_SALT,
        password_hash: md5Digest(E2E_PASSWORD, E2E_SALT),
      },
      [E2E_USERNAME_2]: {
        display_name: "E2E User Two",
        role: "admin",
        spaces: [],
        must_change_password: false,
        password_salt: E2E_SALT_2,
        password_hash: md5Digest(E2E_PASSWORD_2, E2E_SALT_2),
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
    await fs.writeFile(path.join(SPACES_DIR, `${SPACE_ID}.txt`), `${SPACE_CONTENT}\n`, "utf8");

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
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-30000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);
    await waitForServer(baseUrl, serverProcess, () => serverLogs);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });
    context1 = await browser.newContext();
    context2 = await browser.newContext();
    page1 = await context1.newPage();
    page2 = await context2.newPage();
    attachPageLogCollectors(page1, browserLogs1);
    attachPageLogCollectors(page2, browserLogs2);

    await loginAndConnectToSpace({
      page: page1,
      baseUrl,
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "click-reg-user1",
      screenshotNamer: nextScreenshotName,
    });
    await loginAndConnectToSpace({
      page: page2,
      baseUrl,
      username: E2E_USERNAME_2,
      password: E2E_PASSWORD_2,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "click-reg-user2",
      screenshotNamer: nextScreenshotName,
    });

    const caretIndex = await page1.locator("#task-editor").evaluate((el) => {
      const target = "already exists";
      const idx = el.value.indexOf(target);
      if (idx < 0) {
        throw new Error("Could not find caret target text in seeded document.");
      }
      return idx + 4;
    });

    await setEditorSelection(page1, caretIndex, caretIndex);
    await page1.bringToFront();
    await page1.locator("#code-editor").click();
    await page1.screenshot({
      path: path.join(runArtifactsDir, nextScreenshotName("click-reg-user1-caret.png")),
      fullPage: true,
    });

    let sourceCaretRect = null;
    await expect.poll(async () => {
      const rects = await getVisibleSourceEditorDisplayRects(page1);
      const candidate = rects.cursor.find((entry) => entry.width <= 3) || rects.cursor[0] || null;
      sourceCaretRect = candidate;
      return Boolean(candidate);
    }, { timeout: 5000 }).toBe(true);

    let remoteCursorBeforeClick = null;
    await expect.poll(async () => {
      const overlays = await getVisibleRemoteOverlays(page2);
      const candidate = overlays.selections.find((entry) => entry.rect.width <= 2) || null;
      remoteCursorBeforeClick = candidate;
      return Boolean(candidate);
    }, { timeout: 10000 }).toBe(true);
    assertRectClose(
      remoteCursorBeforeClick.rect,
      sourceCaretRect,
      "remote cursor before user2 click vs user1 caret",
      6
    );

    // Stabilize the screenshot region so image comparison detects position shifts only.
    await page2.addStyleTag({
      content: `
        * {
          animation: none !important;
          transition: none !important;
        }
        #code-editor .cm-cursorLayer .cm-cursor,
        #code-editor .cm-selectionLayer .cm-selectionBackground,
        #code-editor .cm-activeLine,
        #code-editor .cm-activeLineGutter,
        .nameTag,
        .cm-ySelectionInfo,
        .yRemoteSelectionInfo {
          visibility: hidden !important;
          opacity: 0 !important;
        }
      `,
    });
    await delay(50);
    const visualClip = buildScreenshotClipAroundRect(page2, remoteCursorBeforeClick.rect, 28);
    const remoteCursorClipBefore = await page2.screenshot({ clip: visualClip });
    await fs.mkdir(runArtifactsDir, { recursive: true });
    const remoteCursorBeforeClipFile = nextScreenshotName("click-reg-user2-remote-cursor-before-clip.png");
    await fs.writeFile(
      path.join(runArtifactsDir, remoteCursorBeforeClipFile),
      remoteCursorClipBefore
    );

    // Trigger the focus/click path on user2 without typing.
    await page2.bringToFront();
    const clickTarget = await page2.evaluate(() => {
      const content = document.querySelector("#code-editor .cm-content");
      const rect = content?.getBoundingClientRect?.();
      if (!rect) {
        throw new Error("CodeMirror content rect not found.");
      }
      return {
        x: rect.left + Math.min(40, Math.max(8, rect.width * 0.1)),
        y: rect.top + Math.min(40, Math.max(8, rect.height * 0.2)),
      };
    });
    await page2.mouse.click(clickTarget.x, clickTarget.y);
    await page2.screenshot({
      path: path.join(runArtifactsDir, nextScreenshotName("click-reg-user2-after-click.png")),
      fullPage: true,
    });

    let remoteCursorAfterClick = null;
    await expect.poll(async () => {
      const overlays = await getVisibleRemoteOverlays(page2);
      const candidate = overlays.selections.find((entry) => entry.rect.width <= 2) || null;
      remoteCursorAfterClick = candidate;
      return Boolean(candidate);
    }, { timeout: 5000 }).toBe(true);

    assert.ok(
      remoteCursorAfterClick.rect.x > 20 && remoteCursorAfterClick.rect.y > 20,
      `remote cursor should not jump to top-left (got x=${remoteCursorAfterClick.rect.x}, y=${remoteCursorAfterClick.rect.y})`
    );
    assertRectClose(
      remoteCursorAfterClick.rect,
      sourceCaretRect,
      "remote cursor after user2 click vs user1 caret",
      6
    );

    await delay(50);
    const remoteCursorClipAfter = await page2.screenshot({ clip: visualClip });
    const remoteCursorAfterClipFile = nextScreenshotName("click-reg-user2-remote-cursor-after-clip.png");
    await fs.writeFile(
      path.join(runArtifactsDir, remoteCursorAfterClipFile),
      remoteCursorClipAfter
    );
    const remoteCursorDiff = await createPngDiffArtifact(page2, remoteCursorClipBefore, remoteCursorClipAfter);
    const remoteCursorDiffFile = nextScreenshotName("click-reg-user2-remote-cursor-diff-clip.png");
    await fs.writeFile(path.join(runArtifactsDir, remoteCursorDiffFile), remoteCursorDiff.buffer);
    assertImageBuffersEqual(
      remoteCursorClipAfter,
      remoteCursorClipBefore,
      "remote cursor visual clip should remain unchanged after user2 click"
    );

    await writeArtifact(
      path.join(runArtifactsDir, "click-cursor-regression-coordinates.json"),
      `${JSON.stringify(
        {
          user1CaretRect: sourceCaretRect,
          user2RemoteBeforeClick: remoteCursorBeforeClick?.rect || null,
          user2RemoteAfterClick: remoteCursorAfterClick?.rect || null,
          user2ClickPoint: clickTarget,
          visualClip,
          visualComparison: {
            beforeClip: remoteCursorBeforeClipFile,
            afterClip: remoteCursorAfterClipFile,
            diffClip: remoteCursorDiffFile,
            diffChangedPixels: remoteCursorDiff.changedPixels,
            diffSize: { width: remoteCursorDiff.width, height: remoteCursorDiff.height },
          },
        },
        null,
        2
      )}\n`
    );
    await writeArtifact(path.join(runArtifactsDir, "browser-user1.log"), `${browserLogs1.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "browser-user2.log"), `${browserLogs2.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
    console.log(`Artifacts saved to ${runArtifactsDir}`);
  } catch (error) {
    try {
      await fs.mkdir(runArtifactsDir, { recursive: true });
      if (page1) {
        await page1.screenshot({
          path: path.join(runArtifactsDir, "failure-user1.png"),
          fullPage: true,
        });
      }
      if (page2) {
        await page2.screenshot({
          path: path.join(runArtifactsDir, "failure-user2.png"),
          fullPage: true,
        });
      }
      await writeArtifact(path.join(runArtifactsDir, "browser-user1.log"), `${browserLogs1.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "browser-user2.log"), `${browserLogs2.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
      console.log(`Failure artifacts saved to ${runArtifactsDir}`);
    } catch {
      // Ignore artifact write failures.
    }
    if (error instanceof Error) {
      error.message = `${error.message}\n(Test: user2 click should not move user1 remote cursor to 0,0)`;
    }
    throw error;
  } finally {
    if (context1) {
      await context1.close().catch(() => { });
    }
    if (context2) {
      await context2.close().catch(() => { });
    }
    if (browser) {
      await browser.close().catch(() => { });
    }
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});

test("chrome e2e: remote cursor and selection overlay match source user selection position", async (t) => {
  if (!(await hasBindCapability())) {
    t.skip("Socket bind is not permitted in this environment.");
    return;
  }
  if (!fssync.existsSync(CHROME_PATH)) {
    t.skip(`Chrome not found at ${CHROME_PATH}`);
    return;
  }

  const previousUsers = await readOptional(USERS_FILE);
  const previousSessions = await readOptional(SESSIONS_FILE);
  const spacesBackup = `${SPACES_DIR}.__chrome_e2e_cursor_overlay_backup__`;
  const ystoreBackup = `${YSTORE_DIR}.__chrome_e2e_cursor_overlay_backup__`;
  let serverProcess = null;
  let browser = null;
  let context1 = null;
  let context2 = null;
  let page1 = null;
  let page2 = null;
  let serverLogs = "";
  const browserLogs1 = [];
  const browserLogs2 = [];
  const runArtifactsDir = path.join(ARTIFACTS_ROOT, `${timestampSlug()}-cursor-overlay`);
  const nextScreenshotName = createScreenshotNamer();

  const usersFixture = {
    users: {
      [E2E_USERNAME]: {
        display_name: "E2E Admin",
        role: "admin",
        spaces: [],
        must_change_password: false,
        password_salt: E2E_SALT,
        password_hash: md5Digest(E2E_PASSWORD, E2E_SALT),
      },
      [E2E_USERNAME_2]: {
        display_name: "E2E User Two",
        role: "admin",
        spaces: [],
        must_change_password: false,
        password_salt: E2E_SALT_2,
        password_hash: md5Digest(E2E_PASSWORD_2, E2E_SALT_2),
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
    await fs.writeFile(path.join(SPACES_DIR, `${SPACE_ID}.txt`), `${SPACE_CONTENT}\n`, "utf8");

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
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-24000);
    };
    serverProcess.stdout.on("data", appendLogs);
    serverProcess.stderr.on("data", appendLogs);

    await waitForServer(baseUrl, serverProcess, () => serverLogs);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    context1 = await browser.newContext();
    page1 = await context1.newPage();
    attachPageLogCollectors(page1, browserLogs1);

    context2 = await browser.newContext();
    page2 = await context2.newPage();
    attachPageLogCollectors(page2, browserLogs2);

    await loginAndConnectToSpace({
      page: page1,
      baseUrl,
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "cursor-user1",
      screenshotNamer: nextScreenshotName,
    });
    await loginAndConnectToSpace({
      page: page2,
      baseUrl,
      username: E2E_USERNAME_2,
      password: E2E_PASSWORD_2,
      spaceId: SPACE_ID,
      artifactsDir: runArtifactsDir,
      screenshotPrefix: "cursor-user2",
      screenshotNamer: nextScreenshotName,
    });

    const selectionRange = await page1.locator("#task-editor").evaluate((el) => {
      const target = "Existing";
      const start = el.value.indexOf(target);
      if (start < 0) {
        throw new Error("Selection target text not found in editor.");
      }
      return { start, end: start + target.length };
    });

    await setEditorSelection(page1, selectionRange.start, selectionRange.end);
    await page1.bringToFront();
    await page1.locator("#task-editor").focus();
    await page1.screenshot({
      path: path.join(
        runArtifactsDir,
        nextScreenshotName("cursor-source-selection-user1.png")
      ),
      fullPage: true,
    });
    await page2.bringToFront();

    let selectionOverlay = null;
    await expect.poll(async () => {
      const overlays = await getVisibleRemoteOverlays(page2);
      const candidate = overlays.selections.find((entry) => entry.rect.width > 2);
      selectionOverlay = candidate || null;
      return Boolean(candidate);
    }, { timeout: 10000 }).toBe(true);

    let sourceSelectionRect = null;
    await expect.poll(async () => {
      const rects = await getVisibleSourceEditorDisplayRects(page1);
      const candidate = rects.selection.find((entry) => entry.width > 2) || null;
      sourceSelectionRect = candidate;
      return Boolean(candidate);
    }, { timeout: 5000 }).toBe(true);
    const expectedSelectionRect = await getExpectedRemoteOverlayRect(
      page2,
      selectionRange.start,
      selectionRange.end
    );
    assertRectClose(selectionOverlay.rect, sourceSelectionRect, "remote selection overlay vs user1 selection");
    assertRectClose(selectionOverlay.rect, expectedSelectionRect, "remote selection overlay");

    const nameTags = await getVisibleRemoteOverlays(page2);
    assert.ok(nameTags.names.length >= 1, "remote user name tag should be visible");
    assert.ok(nameTags.names[0].text.length > 0, "remote user name tag should have text");

    await page2.screenshot({
      path: path.join(
        runArtifactsDir,
        nextScreenshotName("cursor-overlay-selection.png")
      ),
      fullPage: true,
    });

    const caretIndex = selectionRange.end + 1;
    await setEditorSelection(page1, caretIndex, caretIndex);
    await page1.bringToFront();
    await page1.locator("#task-editor").focus();
    await page1.screenshot({
      path: path.join(
        runArtifactsDir,
        nextScreenshotName("cursor-source-caret-user1.png")
      ),
      fullPage: true,
    });
    await page2.bringToFront();

    let caretOverlay = null;
    await expect.poll(async () => {
      const overlays = await getVisibleRemoteOverlays(page2);
      const candidate = overlays.selections.find((entry) => entry.rect.width <= 2);
      caretOverlay = candidate || null;
      return Boolean(candidate);
    }, { timeout: 10000 }).toBe(true);

    let sourceCaretRect = null;
    await expect.poll(async () => {
      const rects = await getVisibleSourceEditorDisplayRects(page1);
      const candidate = rects.cursor.find((entry) => entry.width <= 3) || rects.cursor[0] || null;
      sourceCaretRect = candidate;
      return Boolean(candidate);
    }, { timeout: 5000 }).toBe(true);
    const expectedCaretRect = await getExpectedRemoteOverlayRect(page2, caretIndex, caretIndex);
    assertRectClose(caretOverlay.rect, sourceCaretRect, "remote caret overlay vs user1 caret");
    assertRectClose(caretOverlay.rect, expectedCaretRect, "remote caret overlay");
    assert.ok(caretOverlay.rect.width <= 2, "remote caret overlay should render as a thin caret");

    await page2.screenshot({
      path: path.join(
        runArtifactsDir,
        nextScreenshotName("cursor-overlay-caret.png")
      ),
      fullPage: true,
    });

    await writeArtifact(path.join(runArtifactsDir, "browser-user1.log"), `${browserLogs1.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "browser-user2.log"), `${browserLogs2.join("\n")}\n`);
    await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
    await writeArtifact(
      path.join(runArtifactsDir, "cursor-overlay-coordinates.json"),
      `${JSON.stringify(
        {
          selection: {
            range: selectionRange,
            user1Rect: sourceSelectionRect,
            user2ExpectedRect: expectedSelectionRect,
            user2OverlayRect: selectionOverlay?.rect || null,
          },
          caret: {
            index: caretIndex,
            user1Rect: sourceCaretRect,
            user2ExpectedRect: expectedCaretRect,
            user2OverlayRect: caretOverlay?.rect || null,
          },
        },
        null,
        2
      )}\n`
    );
    console.log(`Artifacts saved to ${runArtifactsDir}`);
  } catch (error) {
    try {
      await fs.mkdir(runArtifactsDir, { recursive: true });
      if (page1) {
        await page1.screenshot({
          path: path.join(runArtifactsDir, "failure-user1.png"),
          fullPage: true,
        });
      }
      if (page2) {
        await page2.screenshot({
          path: path.join(runArtifactsDir, "failure-user2.png"),
          fullPage: true,
        });
      }
      await writeArtifact(path.join(runArtifactsDir, "browser-user1.log"), `${browserLogs1.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "browser-user2.log"), `${browserLogs2.join("\n")}\n`);
      await writeArtifact(path.join(runArtifactsDir, "server.log"), `${serverLogs}\n`);
      console.log(`Failure artifacts saved to ${runArtifactsDir}`);
    } catch {
      // Ignore artifact write failures.
    }
    if (error instanceof Error) {
      error.message = `${error.message}\n(Test: remote cursor/selection overlay visual alignment)`;
    }
    throw error;
  } finally {
    if (context1) {
      await context1.close().catch(() => { });
    }
    if (context2) {
      await context2.close().catch(() => { });
    }
    if (browser) {
      await browser.close().catch(() => { });
    }
    await stopServer(serverProcess);
    await restoreFile(USERS_FILE, previousUsers);
    await restoreFile(SESSIONS_FILE, previousSessions);
    await restoreDir(SPACES_DIR, spacesBackup);
    await restoreDir(YSTORE_DIR, ystoreBackup);
  }
});
