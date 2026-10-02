import test from "node:test";
import assert from "node:assert/strict";
import { publicUpdateManifest } from "./public-update-manifest.mjs";
const repository = "Nan-WenYuan/GameSaveManager-Releases";
const fixture = () => ({
  tag_name: "v1.11.3",
  body: "更新说明",
  draft: false,
  prerelease: false,
  assets: ["rgsm.exe", "SHA256SUMS"].map((name, index) => ({
    id: index + 1,
    name,
    size: 100,
    browser_download_url: `https://github.com/${repository}/releases/download/v1.11.3/${name}`,
    uploader: { secret: "not exported" },
  })),
});
test("manifest only exposes required public update fields", () => {
  const result = publicUpdateManifest(fixture(), repository);
  assert.equal(result.assets[0].uploader, undefined);
  assert.equal(result.tag_name, "v1.11.3");
});
test("rejects draft, missing checksum and redirected asset URLs", () => {
  assert.throws(() =>
    publicUpdateManifest({ ...fixture(), draft: true }, repository),
  );
  const noChecksum = fixture();
  noChecksum.assets.pop();
  assert.throws(() => publicUpdateManifest(noChecksum, repository));
  const redirected = fixture();
  redirected.assets[0].browser_download_url = "https://example.com/rgsm.exe";
  assert.throws(() => publicUpdateManifest(redirected, repository));
});
