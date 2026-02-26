import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(FRONTEND_DIR, "dist");

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

async function verifyBuiltEntry() {
  const appEntry = path.join(DIST_DIR, "scripts", "app.js");
  await fs.stat(appEntry);
}

async function writeReadme() {
  const text = [
    "Generated frontend build output",
    "",
    "Serve the frontend project root and open /dist/index.html.",
    "This keeps absolute /node_modules import-map paths working without duplicating dependencies.",
    "",
    "Example:",
    "  cd frontend",
    "  npm run dev",
    "  # then open http://127.0.0.1:4173/dist/index.html",
    "",
  ].join("\n");
  await fs.writeFile(path.join(DIST_DIR, "README.txt"), text, "utf8");
}

async function main() {
  await verifyBuiltEntry();
  await copyEntry("index.html");
  await copyEntry("styles");
  await copyEntry("assets");
  await writeReadme();
  console.log("Built frontend dist output in ./dist (open /dist/index.html when serving frontend root).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
