import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export function validatePublicSourcePaths(paths) {
  if (
    paths.some(
      (file) =>
        file !==
          "apps/rgsm-gui/e2e/fixtures/legacy-cloud-v1/GameSaveManager.config.json" &&
        (/^(data|save_data|backups|cloud|交付|项目资料)\//i.test(file) ||
          /(^|\/)\.env($|\.(?!example$))/.test(file) ||
          /(^|\/)GameSaveManager\.(config|host)(\.|\/|$)/i.test(file)),
    )
  )
    throw new Error("源码包含运行数据或个人配置，停止公有发布。");
}

/** Publish one source tree with public-only ancestry; never push private branches. */
export async function publishPublicSource({
  root,
  sourceCommit,
  publicRemote,
  version,
}) {
  await mkdir(path.join(root, "项目资料/临时"), { recursive: true });
  const temporary = await mkdtemp(
    path.join(root, "项目资料/临时/public-source-"),
  );
  const environment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_INDEX_FILE: path.join(temporary, "index"),
  };
  function git(args, input) {
    return execFileSync("git", args, {
      cwd: root,
      env: environment,
      input,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
  }
  try {
    const paths = git(["ls-tree", "-r", "--name-only", "-z", sourceCommit])
      .split("\0")
      .filter(Boolean);
    validatePublicSourcePaths(paths);
    git(["fetch", "--no-tags", publicRemote, "main"]);
    const parent = git(["rev-parse", "FETCH_HEAD"]);
    // Use a separate index; neither the developer's checkout nor index is changed.
    git(["read-tree", sourceCommit]);
    const manifest = git(["rev-parse", `${parent}:latest.json`]);
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${manifest},latest.json`,
    ]);
    const sourceReadme = git(["show", `${sourceCommit}:README.md`]);
    const readme = sourceReadme.replace(
      /## 仓库分工[\s\S]*?(?=\n## |$)/,
      `## 源码与更新\n\n本公有仓库的 \`main\` 分支提供程序源码，版本标签与 Releases 对应。当前源码版本：**${version}**。\n\n个人游戏存档、配置和凭据保存在本地或个人私有仓库，不包含在本仓库。程序更新从本仓库 Releases 匿名下载。\n\n开发环境：Rust、Node.js 与 pnpm。安装 Tauri 平台依赖后运行 \`pnpm install\`，使用 \`pnpm dev\` 开发、\`pnpm build\` 构建；详细开发和构建说明见 [AGENTS.md](AGENTS.md)。\n\n每次正式发布同步对应源码，保留许可证和原作者声明；Release 附件同时提供完整源码 ZIP。\n`,
    );
    const readmeBlob = git(["hash-object", "-w", "--stdin"], `${readme}\n`);
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${readmeBlob},README.md`,
    ]);
    const tree = git(["write-tree"]);
    if (tree === git(["rev-parse", `${parent}^{tree}`])) return parent;
    const commit = git(
      ["commit-tree", tree, "-p", parent],
      `chore(source): publish program source ${version}\n\nCorresponding source: ${sourceCommit}\n`,
    );
    // A normal fast-forward push rejects concurrent remote changes.
    git(["push", publicRemote, `${commit}:refs/heads/main`]);
    return commit;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Only these program repositories are valid, including the one-time rename bridge. */
export function releaseRepository(args) {
  if (args.includes("--bridge-private"))
    throw new Error("程序发布不再写入私有存档仓库。");
  const index = args.indexOf("--repository");
  const repository =
    index < 0 ? "Nan-WenYuan/GameSaveManager" : args[index + 1];
  if (
    ![
      "Nan-WenYuan/GameSaveManager",
      "Nan-WenYuan/GameSaveManager-Releases",
    ].includes(repository)
  )
    throw new Error("发布仓库必须为受信的公有程序仓库。");
  return repository;
}

/** Advance main to an already-public development commit without rewriting its identity. */
export async function advancePublicSource({
  root,
  sourceCommit,
  publicRemote,
}) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    }).trim();
  validatePublicSourcePaths(
    git(["ls-tree", "-r", "--name-only", "-z", sourceCommit])
      .split("\0")
      .filter(Boolean),
  );
  git(["fetch", "--no-tags", publicRemote, "main"]);
  const parent = git(["rev-parse", "FETCH_HEAD"]);
  git(["fetch", "--no-tags", publicRemote, "personal-dev"]);
  const development = git(["rev-parse", "FETCH_HEAD"]);
  if (development !== sourceCommit)
    throw new Error("发布提交必须已推送到公有 personal-dev 分支。");
  try {
    git(["merge-base", "--is-ancestor", parent, sourceCommit]);
  } catch {
    throw new Error("请先合入公有 main 的最新更改，再发布；不导入私有历史。");
  }
  git(["push", publicRemote, `${sourceCommit}:refs/heads/main`]);
  return sourceCommit;
}
