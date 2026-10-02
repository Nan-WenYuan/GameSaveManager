// Modified From https://github.com/zzzgydi/clash-verge/blob/main/scripts/portable.mjs
// GPL-3.0
import { existsSync } from "node:fs";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
export function resolveRepoRoot(startDir = scriptDir) {
  let currentDir = startDir;

  while (true) {
    const cargoTomlPath = path.join(currentDir, "Cargo.toml");
    const guiPackagePath = path.join(
      currentDir,
      "apps",
      "rgsm-gui",
      "package.json",
    );

    if (existsSync(cargoTomlPath) && existsSync(guiPackagePath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("could not resolve repository root");
    }
    currentDir = parentDir;
  }
}

// Lazily resolved so that importing pure helpers (e.g. parseWorkspaceVersion)
// from outside the repository tree does not throw at import time.
let _repoRoot;
export function getRepoRoot() {
  if (_repoRoot === undefined) {
    _repoRoot = resolveRepoRoot();
  }
  return _repoRoot;
}

export function createPortablePaths(rootDir = getRepoRoot()) {
  return {
    releaseDir: path.join(rootDir, "target", "release"),
    cargoTomlPath: path.join(rootDir, "Cargo.toml"),
  };
}

async function importActionsGithub(rootDir) {
  const entryPath = path.join(
    rootDir,
    "apps",
    "rgsm-gui",
    "node_modules",
    "@actions",
    "github",
    "lib",
    "github.js",
  );

  return await import(pathToFileURL(entryPath).href);
}

export function parseWorkspaceVersion(cargoToml) {
  let inWorkspacePackage = false;

  for (const rawLine of cargoToml.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("[") && line.endsWith("]")) {
      inWorkspacePackage = line === "[workspace.package]";
      continue;
    }

    if (!inWorkspacePackage) {
      continue;
    }

    const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
    if (versionMatch) {
      return versionMatch[1];
    }
  }

  throw new Error("could not read version from workspace Cargo.toml");
}

export function getReleaseUploadConfig(env = process.env) {
  const releaseId = env.RELEASE_ID?.trim() ?? "";

  if (!releaseId) {
    return null;
  }

  const githubToken = env.GITHUB_TOKEN?.trim() ?? "";

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required");
  }

  return { releaseId, githubToken };
}

export function isReleaseAssetNameConflict(error) {
  if (error?.status !== 422) {
    return false;
  }

  const errors = error.response?.data?.errors;
  if (!Array.isArray(errors)) {
    return false;
  }

  return errors.some(
    (entry) =>
      entry?.resource === "ReleaseAsset" &&
      entry?.code === "already_exists" &&
      entry?.field === "name",
  );
}

function hasCauseCode(error, codes) {
  let current = error;
  while (current && typeof current === "object") {
    if (codes.has(current.code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function isRetriableReleaseAssetUploadError(error) {
  const status = Number(error?.status ?? 0);
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    return true;
  }

  return hasCauseCode(
    error,
    new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]),
  );
}

function describeReleaseAssetUploadError(error) {
  const status = error?.status ? `HTTP ${error.status}` : "network error";
  const message = error?.message ? `: ${error.message}` : "";
  return `${status}${message}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadReleaseAssetWithRetry(
  upload,
  { log, retryDelaysMs = [2_000, 5_000, 10_000] },
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await upload();
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (
        retryDelayMs === undefined ||
        !isRetriableReleaseAssetUploadError(error)
      ) {
        throw error;
      }

      log(
        `[INFO]: release asset upload failed (${describeReleaseAssetUploadError(
          error,
        )}), retrying in ${retryDelayMs}ms`,
      );
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
}

export async function deleteReleaseAssetByName(
  github,
  options,
  releaseId,
  name,
) {
  const assets = await github.rest.repos.listReleaseAssets({
    ...options,
    release_id: releaseId,
    per_page: 100,
  });

  const existingAsset = assets.data.find((asset) => asset.name === name);
  if (!existingAsset) {
    return false;
  }

  await github.rest.repos.deleteReleaseAsset({
    ...options,
    asset_id: existingAsset.id,
  });

  return true;
}

export async function uploadReleaseAssetWithClobber({
  github,
  options,
  releaseId,
  name,
  data,
  log = console.log,
  retryDelaysMs,
}) {
  const upload = () =>
    github.rest.repos.uploadReleaseAsset({
      ...options,
      release_id: releaseId,
      name,
      data,
    });

  try {
    return await uploadReleaseAssetWithRetry(upload, { log, retryDelaysMs });
  } catch (error) {
    if (!isReleaseAssetNameConflict(error)) {
      throw error;
    }

    const deleted = await deleteReleaseAssetByName(
      github,
      options,
      releaseId,
      name,
    );
    if (deleted) {
      log(`[INFO]: deleted existing release asset ${name}`);
    } else {
      log(`[INFO]: release asset ${name} was already removed, retry upload`);
    }

    return await uploadReleaseAssetWithRetry(upload, { log, retryDelaysMs });
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function createPortableName(version, date = new Date(), type = "R") {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Invalid semantic version");
  if (!["dev", "Beta", "RC", "R", "SC", "Base", "UI"].includes(type))
    throw new Error("Invalid release type");
  if (Number.isNaN(date.getTime())) throw new Error("Invalid build date");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (key) => parts.find((item) => item.type === key).value;
  const timestamp =
    part("year") +
    part("month") +
    part("day") +
    "_" +
    part("hour") +
    part("minute") +
    part("second");
  return "游戏存档管理器-" + version + "." + timestamp + "_" + type;
}

export async function resolvePortable() {
  if (process.platform !== "win32") return;
  const root = getRepoRoot();
  const { releaseDir, cargoTomlPath } = createPortablePaths(root);
  const source = path.join(releaseDir, "rgsm.exe");
  if (!(await pathExists(source)))
    throw new Error("could not find the release executable");
  const version = parseWorkspaceVersion(await readFile(cargoTomlPath, "utf-8"));
  const name = createPortableName(version);
  const destination = path.join(root, "交付", name);
  if (await pathExists(destination))
    throw new Error("Delivery directory already exists: " + destination);
  await mkdir(destination, { recursive: true });
  await copyFile(
    source,
    path.join(destination, "游戏存档管理器.exe"),
  );
  console.log("[INFO]: portable folder created: " + destination);
  return destination;
}

export async function runPortableCli({
  resolvePortableFn = resolvePortable,
  logError = console.error,
} = {}) {
  try {
    await resolvePortableFn();
    return 0;
  } catch (error) {
    logError(error);
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runPortableCli();
}
