export function publicUpdateManifest(release, repository) {
  if (
    release.draft ||
    release.prerelease ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
  ) {
    throw new Error("只能公开正式版本的更新清单。");
  }
  const assets = release.assets.map(
    ({ id, name, size, browser_download_url }) => {
      const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${encodeURIComponent(name)}`;
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        browser_download_url !== expected
      ) {
        throw new Error("更新清单附件地址或大小无效。");
      }
      return { id, name, size, browser_download_url };
    },
  );
  if (
    !assets.some(({ name }) => name === "rgsm.exe") ||
    !assets.some(({ name }) => name === "SHA256SUMS")
  ) {
    throw new Error("更新清单缺少程序或校验文件。");
  }
  return {
    tag_name: release.tag_name,
    body: release.body ?? "",
    draft: false,
    prerelease: false,
    assets,
  };
}
