// Upload existing backups through the real application API. Never restore games.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export async function uploadExistingGithubBackups({
  packageDirectory,
  owner,
  repository,
  remoteRoot = "cloud",
  expectedArchives,
}) {
  packageDirectory = path.resolve(packageDirectory);
  const executable = path.join(packageDirectory, "游戏存档管理器.exe");
  await fs.access(executable);
  const credential = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    windowsHide: true,
  });
  const token = credential
    .split(/\r?\n/)
    .find((line) => line.startsWith("password="))
    ?.slice(9);
  if (!token) throw new Error("GitHub credential is unavailable");
  let child;
  let host;
  let verificationDirectory;
  const api = async (command, body = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${host.port}/api/v1/${command}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(300000),
        headers: {
          Authorization: `Bearer ${host.api_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${command}: HTTP ${response.status}: ${text.replaceAll(token, "[redacted]")}`,
      );
    return text ? JSON.parse(text) : null;
  };
  try {
    child = spawn(executable, [], {
      env: { ...process.env, RGSM_HTTP_HOST_ONLY: "1" },
      windowsHide: true,
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        host = JSON.parse(
          await fs.readFile(
            path.join(packageDirectory, "data", "GameSaveManager.host.json"),
            "utf8",
          ),
        );
        await api("get-local-config");
        break;
      } catch (error) {
        if (child.exitCode !== null) throw new Error("Application host exited");
        if (attempt === 99)
          throw new Error("Application host startup timed out");
        await sleep(200);
      }
    }
    const config = await api("get-local-config");
    const originalPaths = structuredClone(
      config.games.map((game) => ({
        name: game.name,
        save_paths: game.save_paths,
        game_paths: game.game_paths,
      })),
    );
    const originalBackupPath = config.backup_path;
    const root = path.isAbsolute(config.backup_path)
      ? config.backup_path
      : path.join(packageDirectory, config.backup_path);
    const archives = [];
    for (const game of config.games) {
      const metadata = await api("get-game-snapshots-info", { game });
      for (const snapshot of metadata.backups) {
        const extension = snapshot.archive_format === "seven_z" ? "7z" : "zip";
        const file = path.join(
          root,
          game.storage_key || game.name,
          `${snapshot.date}.${extension}`,
        );
        archives.push({
          game,
          snapshot,
          file,
          hash: hash(await fs.readFile(file)),
        });
      }
    }
    if (expectedArchives !== undefined)
      assert.equal(
        archives.length,
        expectedArchives,
        "Unexpected archive count",
      );
    console.log(
      `Prepared ${config.games.length} games and ${archives.length} backups; live-save paths unchanged`,
    );
    for (const game of config.games) game.cloud_sync_enabled = true;
    config.settings.cloud_settings = {
      auto_sync_interval: 0,
      max_concurrency: 1,
      root_path: remoteRoot,
      backend: { type: "GitHub", owner, repository, branch: "saves", token },
    };
    await api("set-config", { config });
    const status = await api("inspect-cloud-library");
    if (status.kind === "empty")
      await api("create-cloud-library", { confirmed: true });
    else if (status.kind !== "active")
      throw new Error(`Cloud requires explicit handling: ${status.kind}`);
    let library = await api("get-cloud-archive-library");
    let uploaded = 0;
    for (const [index, archive] of archives.entries()) {
      const gameId = archive.game.storage_key || archive.game.name;
      const listed = library.games
        .find((game) => game.game_id === gameId)
        ?.snapshots.find(
          (snapshot) => snapshot.snapshot_id === archive.snapshot.date,
        );
      if (!listed?.cloud_verified) {
        await api("upload-cloud-archive", {
          gameId,
          snapshotId: archive.snapshot.date,
        });
        uploaded++;
      }
      console.log(
        `[${index + 1}/${archives.length}] verified: ${archive.game.name} ${archive.snapshot.date}`,
      );
    }
    library = await api("refresh-cloud-archive-library");
    for (const archive of archives) {
      const snapshot = library.games
        .find(
          (game) =>
            game.game_id === (archive.game.storage_key || archive.game.name),
        )
        ?.snapshots.find(
          (snapshot) => snapshot.snapshot_id === archive.snapshot.date,
        );
      assert(snapshot?.cloud_verified, "Remote backup verification is missing");
      assert.equal(snapshot.description, archive.snapshot.describe);
      assert.equal(snapshot.parent, archive.snapshot.parent);
      assert.equal(
        hash(await fs.readFile(archive.file)),
        archive.hash,
        "Local archive changed",
      );
    }
    const treeResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repository}/git/trees/saves?recursive=1`,
      {
        signal: AbortSignal.timeout(60000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!treeResponse.ok)
      throw new Error(`GitHub tree HTTP ${treeResponse.status}`);
    const tree = await treeResponse.json();
    assert.equal(tree.truncated, false);
    const sample =
      archives.find((archive) => archive.file.endsWith(".zip")) || archives[0];
    const matching = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path.startsWith(`${remoteRoot}/`) &&
        entry.path.includes(
          `/${sample.game.storage_key || sample.game.name}/`,
        ) &&
        entry.path.endsWith(path.basename(sample.file)),
    );
    assert.equal(
      matching.length,
      1,
      "Cannot uniquely locate sample remote archive",
    );
    const contentResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repository}/contents/${matching[0].path.split("/").map(encodeURIComponent).join("/")}?ref=saves`,
      {
        signal: AbortSignal.timeout(60000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
        },
      },
    );
    if (!contentResponse.ok)
      throw new Error(`GitHub download HTTP ${contentResponse.status}`);
    const bytes = Buffer.from(await contentResponse.arrayBuffer());
    verificationDirectory = await fs.mkdtemp(
      path.join(repoRoot, "项目资料/临时/github-download-"),
    );
    const downloaded = path.join(verificationDirectory, "verified.zip");
    await fs.writeFile(downloaded, bytes);
    assert.equal(
      hash(await fs.readFile(downloaded)),
      sample.hash,
      "Downloaded ZIP differs",
    );
    const after = await api("get-local-config");
    assert.equal(after.backup_path, originalBackupPath);
    assert.deepEqual(
      after.games.map((game) => ({
        name: game.name,
        save_paths: game.save_paths,
        game_paths: game.game_paths,
      })),
      originalPaths,
    );
    console.log(
      `PASS: ${archives.length} cloud_verified backups (${uploaded} newly uploaded), descriptions/date/parent and local archives preserved; one ZIP independently downloaded with matching SHA256; no restores`,
    );
    return {
      games: config.games.length,
      archives: archives.length,
      uploaded,
      verifiedDownload: true,
    };
  } finally {
    if (child && child.exitCode === null) {
      const closed = once(child, "exit");
      child.kill();
      await closed;
    }
    if (verificationDirectory) {
      if (
        !verificationDirectory.startsWith(
          path.join(repoRoot, "项目资料/临时") + path.sep,
        )
      )
        throw new Error("Unsafe download cleanup path");
      await fs.rm(verificationDirectory, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [packageDirectory, owner, repository, expected] = process.argv.slice(2);
  if (!packageDirectory || !owner || !repository)
    throw new Error(
      "Usage: node scripts/github-save-sync.mjs PACKAGE_DIRECTORY OWNER REPOSITORY [EXPECTED_ARCHIVES]",
    );
  uploadExistingGithubBackups({
    packageDirectory,
    owner,
    repository,
    expectedArchives: expected ? Number(expected) : undefined,
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
