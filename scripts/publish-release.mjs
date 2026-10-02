import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceVersion } from "./portable.mjs";
import { publicUpdateManifest } from "./public-update-manifest.mjs";
import {
  advancePublicSource,
  releaseRepository,
  validatePublicSourcePaths,
} from "./public-source.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repository = releaseRepository(process.argv.slice(2));
const sourceRepository = repository;
const executableName = "rgsm.exe";

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  }).trim();
}

function githubToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) return token;
  const credential = execFileSync("git", ["credential", "fill"], {
    cwd: root,
    encoding: "utf8",
    input: "protocol=https\nhost=github.com\nusername=Nan-WenYuan\n\n",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  });
  const password = credential
    .split(/\r?\n/)
    .find((line) => line.startsWith("password="));
  if (!password)
    throw new Error("请先登录 GitHub，或通过环境变量配置 GH_TOKEN。");
  return password.slice("password=".length);
}

async function main() {
  if (git(["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("请先提交并推送程序源码，再发布与源码一致的更新。");
  }
  const commit = git(["rev-parse", "HEAD"]);
  const sourceOnly = process.argv.includes("--source-only");
  const sourceRefIndex = process.argv.indexOf("--source-ref");
  const sourceCommit =
    sourceRefIndex >= 0
      ? git(["rev-parse", `${process.argv[sourceRefIndex + 1]}^{commit}`])
      : commit;
  const version = parseWorkspaceVersion(
    git(["show", `${sourceCommit}:Cargo.toml`]),
  );
  const executable = sourceOnly
    ? null
    : await readFile(path.join(root, "target/release/rgsm.exe"));
  if (!sourceOnly) {
    if (executable[0] !== 0x4d || executable[1] !== 0x5a)
      throw new Error("发布文件不是 Windows 程序。");
    const executableVersion = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-Item -LiteralPath $env:RGSM_RELEASE_EXE).VersionInfo.ProductVersion",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RGSM_RELEASE_EXE: path.join(root, "target/release/rgsm.exe"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    if (executableVersion !== version)
      throw new Error("程序文件版本与源码版本不一致。");
    if (sourceCommit !== commit)
      throw new Error("正式发布必须使用当前源码提交。");
  }
  if (git(["rev-parse", "origin/personal-dev"]) !== commit)
    throw new Error("当前源码尚未同步到 origin/personal-dev。");
  const checksum = sourceOnly
    ? null
    : createHash("sha256").update(executable).digest("hex");
  const token = githubToken();
  async function request(url, options = {}, allowNotFound = false) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !["api.github.com", "uploads.github.com"].includes(parsed.hostname)
    ) {
      throw new Error("发布地址不属于受信 GitHub API。");
    }
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "game-save-manager-release",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub 发布请求失败：HTTP ${response.status}`);
    return response.json();
  }
  const sourceBase = `https://api.github.com/repos/${sourceRepository}`;
  const base = `https://api.github.com/repos/${repository}`;
  const repositoryInfo = await request(base);
  if (repositoryInfo.private) throw new Error("程序发布仓库必须为公有仓库。");
  await request(`${sourceBase}/commits/${sourceCommit}`);
  const remote = await request(
    `${sourceBase}/contents/Cargo.toml?ref=${sourceCommit}`,
  );
  const remoteVersion = parseWorkspaceVersion(
    Buffer.from(remote.content, "base64").toString("utf8"),
  );
  if (remoteVersion !== version)
    throw new Error("远程源码版本与本地程序版本不一致。");
  const tag = `v${version}`;
  if (sourceOnly) {
    const existing = await request(`${base}/releases/tags/${tag}`);
    if (existing.draft || existing.prerelease)
      throw new Error("仅可补充正式已发布版本的源码。");
    const publicCommit = await advancePublicSource({
      root,
      sourceCommit,
      publicRemote: `https://github.com/${repository}.git`,
      version,
    });
    await request(`${base}/git/refs/tags/${tag}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: publicCommit, force: true }),
    });
    await request(`${base}/releases/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: `${existing.body}\n\n在线对应源码：https://github.com/${repository}/tree/${tag}`,
      }),
    });
    console.log(
      `已同步 ${version} 源码：https://github.com/${repository}/tree/${publicCommit}`,
    );
    return;
  }
  if (await request(`${base}/releases/tags/${tag}`, {}, true)) {
    throw new Error("该版本已有 Release，请增加版本号；不会覆盖已有更新。");
  }
  // Only archive the committed source tree, never runtime data or another branch.
  const trackedPaths = git(["ls-tree", "-r", "--name-only", commit]).split(
    "\n",
  );
  validatePublicSourcePaths(trackedPaths);
  const sourceArchive = execFileSync(
    "git",
    ["archive", "--format=zip", `--prefix=GameSaveManager-${version}/`, commit],
    {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const publicCommit = await advancePublicSource({
    root,
    sourceCommit,
    publicRemote: `https://github.com/${repository}.git`,
    version,
  });
  const release = await request(`${base}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: publicCommit,
      name: `游戏存档管理器 ${version}`,
      body: `基于 mcthesw/game-save-manager 的个人自用修改版，遵循 AGPL-3.0-only。\n\n对应源码提交：${commit}。在线源码：https://github.com/${repository}/tree/${tag}；完整源码见本版本 source-${version}.zip 附件。\n\n更新仅替换程序，保留配置与存档。修改说明见对应版本 README。`,
      draft: true,
      prerelease: false,
    }),
  });
  const uploadUrl = release.upload_url.replace(/\{.*$/, "");
  for (const asset of [
    {
      name: `source-${version}.zip`,
      body: sourceArchive,
      type: "application/zip",
    },
    {
      name: executableName,
      body: executable,
      type: "application/octet-stream",
    },
    {
      name: "SHA256SUMS",
      body: `${checksum}  ${executableName}\n`,
      type: "text/plain; charset=utf-8",
    },
    {
      name: "LICENSE",
      body: await readFile(path.join(root, "LICENSE")),
      type: "text/plain; charset=utf-8",
    },
  ]) {
    const uploaded = await request(
      `${uploadUrl}?name=${encodeURIComponent(asset.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": asset.type },
        body: asset.body,
      },
    );
    if (
      uploaded.name !== asset.name ||
      uploaded.size !== Buffer.byteLength(asset.body) ||
      uploaded.state !== "uploaded"
    )
      throw new Error("GitHub 改写了更新文件名，版本将保留为草稿。 ");
  }
  const published = await request(`${base}/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false }),
  });
  // Raw GitHub content provides an anonymous fallback when API quota is exhausted.
  const publishedRelease = await request(`${base}/releases/${release.id}`);
  const manifest = publicUpdateManifest(publishedRelease, repository);
  const previousManifest = await request(
    `${base}/contents/latest.json`,
    {},
    true,
  );
  await request(`${base}/contents/latest.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `chore: publish update manifest ${tag}`,
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString(
        "base64",
      ),
      branch: repositoryInfo.default_branch,
      ...(previousManifest ? { sha: previousManifest.sha } : {}),
    }),
  });
  console.log(`已发布：${published.html_url}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
