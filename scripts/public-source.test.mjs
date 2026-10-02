import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  publishPublicSource,
  advancePublicSource,
  releaseRepository,
  validatePublicSourcePaths,
} from "./public-source.mjs";

test("public source rejects runtime data and personal configuration", () => {
  for (const file of [
    "save_data/game.7z",
    "cloud/save.zip",
    ".env.local",
    "data/config.json",
    "GameSaveManager.config.json",
    "项目资料/开发记录.md",
  ]) {
    assert.throws(() => validatePublicSourcePaths([file]));
  }
  validatePublicSourcePaths([
    ".env.example",
    "crates/rgsm-core/src/config.rs",
    "apps/rgsm-gui/e2e/fixtures/legacy-cloud-v1/GameSaveManager.config.json",
  ]);
});

test("source snapshot preserves the public manifest but excludes private ancestry and leaves the local index unchanged", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "rgsm-public-source-test-"),
  );
  const source = path.join(temporary, "source");
  const target = path.join(temporary, "public");
  function git(cwd, ...args) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
  async function init(directory) {
    await mkdir(directory);
    git(directory, "init", "-b", "main");
    git(directory, "config", "user.name", "Source Test");
    git(directory, "config", "user.email", "source-test@example.invalid");
  }
  try {
    await init(source);
    await writeFile(
      path.join(source, "private-old.txt"),
      "private ancestry sentinel",
    );
    git(source, "add", ".");
    git(source, "commit", "-m", "private history");
    const privateAncestor = git(source, "rev-parse", "HEAD");
    git(source, "rm", "private-old.txt");
    await writeFile(
      path.join(source, "README.md"),
      "# Personal edition\n\n## 仓库分工\nPrivate branches\n",
    );
    await writeFile(path.join(source, "app.rs"), "fn main() {}\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "program source");
    const sourceCommit = git(source, "rev-parse", "HEAD");
    const index = git(source, "write-tree");
    await init(target);
    // The receiving repository models a bare GitHub repository for main pushes.
    git(target, "config", "receive.denyCurrentBranch", "ignore");
    await writeFile(path.join(target, "latest.json"), '{"version":"1.12.1"}\n');
    git(target, "add", ".");
    git(target, "commit", "-m", "public update index");
    const published = await publishPublicSource({
      root: source,
      sourceCommit,
      publicRemote: target,
      version: "1.12.1",
    });
    assert.equal(git(target, "rev-parse", "main"), published);
    assert.equal(git(target, "show", "main:app.rs"), "fn main() {}");
    assert.equal(
      git(target, "show", "main:latest.json"),
      '{"version":"1.12.1"}',
    );
    assert.ok(!git(target, "rev-list", "main").includes(privateAncestor));
    assert.ok(
      !git(target, "ls-tree", "-r", "--name-only", "main").includes(
        "private-old.txt",
      ),
    );
    assert.match(git(target, "show", "main:README.md"), /1\.12\.1/);
    assert.equal(git(source, "write-tree"), index);
    assert.equal(git(source, "rev-parse", "HEAD"), sourceCommit);
    const repeated = await publishPublicSource({
      root: source,
      sourceCommit,
      publicRemote: target,
      version: "1.12.1",
    });
    assert.equal(repeated, published);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release defaults to program repository and cannot publish a private saves bridge", () => {
  assert.equal(releaseRepository([]), "Nan-WenYuan/GameSaveManager");
  assert.equal(
    releaseRepository(["--repository", "Nan-WenYuan/GameSaveManager-Releases"]),
    "Nan-WenYuan/GameSaveManager-Releases",
  );
  assert.throws(() =>
    releaseRepository(["--repository", "Nan-WenYuan/Game_Data"]),
  );
  assert.throws(() => releaseRepository(["--bridge-private"]));
});

test("regular release advances main to the exact already-public source commit", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "rgsm-public-advance-test-"),
  );
  const source = path.join(temporary, "source");
  const target = path.join(temporary, "public.git");
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  try {
    await mkdir(source);
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Source Test");
    git(source, "config", "user.email", "source-test@example.invalid");
    await writeFile(path.join(source, "latest.json"), '{"version":"1.12.1"}\n');
    git(source, "add", ".");
    git(source, "commit", "-m", "public parent");
    const parent = git(source, "rev-parse", "HEAD");
    git(temporary, "init", "--bare", target);
    git(source, "push", target, "main");
    git(source, "checkout", "-b", "personal-dev");
    await writeFile(path.join(source, "app.rs"), "fn main() {}\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "public feature");
    const commit = git(source, "rev-parse", "HEAD");
    await assert.rejects(
      advancePublicSource({
        root: source,
        sourceCommit: commit,
        publicRemote: target,
      }),
    );
    git(source, "push", target, "personal-dev");
    assert.equal(
      await advancePublicSource({
        root: source,
        sourceCommit: commit,
        publicRemote: target,
      }),
      commit,
    );
    assert.equal(git(target, "rev-parse", "main"), commit);
    assert.equal(git(target, "rev-parse", "main^"), parent);
    assert.equal(
      git(target, "show", "main:latest.json"),
      '{"version":"1.12.1"}',
    );
    // Unrelated source history must never be grafted onto public main.
    git(source, "checkout", "--orphan", "unrelated");
    git(source, "commit", "-m", "unrelated source history");
    const unrelated = git(source, "rev-parse", "HEAD");
    git(source, "push", target, "unrelated:personal-dev", "--force");
    await assert.rejects(
      advancePublicSource({
        root: source,
        sourceCommit: unrelated,
        publicRemote: target,
      }),
      /main/,
    );
    assert.equal(git(target, "rev-parse", "main"), commit);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
