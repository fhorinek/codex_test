/**
 * Module: Build packaging script that prepares the frontend dist output and static assets.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Stores the __filename module constant.
const __filename = fileURLToPath(import.meta.url);
// Stores the __dirname module constant.
const __dirname = path.dirname(__filename);
// Stores the FRONTEND_DIR module constant.
const FRONTEND_DIR = path.resolve(__dirname, "..");
// Stores the DIST_DIR module constant.
const DIST_DIR = path.join(FRONTEND_DIR, "dist");
// Stores the BUILD_ID_PLACEHOLDER module constant.
const BUILD_ID_PLACEHOLDER = "__TASKSCRIPT_FRONTEND_BUILD_ID__";

/**
 * Creates the frontend build-info payload with a unique build id.
 * Input: none.
 * Output: { buildId: string, builtAt: string }.
 */
function createBuildInfo() {
  const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const builtAt = new Date().toISOString();
  return { buildId, builtAt };
}

/**
 * Copies a frontend build entry (file or directory) into the dist output directory.
 * Input: relativePath: string.
 * Output: Promise<void>.
 */
async function copyEntry(relativePath) {
  const sourcePath = path.join(FRONTEND_DIR, relativePath);
  const targetPath = path.join(DIST_DIR, relativePath);
  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

/**
 * Validates that the compiled frontend app entry exists before packaging dist artifacts.
 * Input: none.
 * Output: Promise<void>.
 */
async function verifyBuiltEntry() {
  const appEntry = path.join(DIST_DIR, "scripts", "app.js");
  await fs.stat(appEntry);
}

/**
 * Writes build metadata consumed by runtime version checks.
 * Input: buildInfo: { buildId: string, builtAt: string }.
 * Output: Promise<void>.
 */
async function writeBuildInfo(buildInfo) {
  await fs.writeFile(
    path.join(DIST_DIR, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Copies index.html into dist while injecting the current build id.
 * Input: buildId: string.
 * Output: Promise<void>.
 */
async function copyBuiltIndex(buildId) {
  const sourcePath = path.join(FRONTEND_DIR, "index.html");
  const targetPath = path.join(DIST_DIR, "index.html");
  const raw = await fs.readFile(sourcePath, "utf8");
  const next = raw.replaceAll(BUILD_ID_PLACEHOLDER, buildId);
  await fs.writeFile(targetPath, next, "utf8");
}

/**
 * Runs dist assembly by validating build output and copying required runtime assets.
 * Input: none.
 * Output: Promise<void>.
 */
async function main() {
  await verifyBuiltEntry();
  const buildInfo = createBuildInfo();
  await copyBuiltIndex(buildInfo.buildId);
  await copyEntry("styles");
  await copyEntry("assets");
  await writeBuildInfo(buildInfo);
  console.log("Built frontend dist output in ./dist for backend static serving.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
