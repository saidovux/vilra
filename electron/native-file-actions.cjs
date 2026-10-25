const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

function createNativeFileActions(options) {
  const {
    fs,
    path,
    shell,
    fetchImpl,
    getLocalOrigin,
    requireTrustedMainFrame,
  } = options;

  async function resolveImageFile(imageId) {
    if (typeof imageId !== 'string' || !IMAGE_ID_PATTERN.test(imageId)) {
      throw new Error('Invalid image ID');
    }
    const origin = new URL(getLocalOrigin());
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') {
      throw new Error('Local Vilra API is unavailable');
    }
    const response = await fetchImpl(
      new URL(`/api/images/${encodeURIComponent(imageId)}/local-file`, origin),
      {headers: {accept: 'application/json'}},
    );
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Local Vilra API returned an invalid response');
    }
    if (!response.ok) {
      throw new Error(String(payload?.detail || payload?.error || 'Image file is unavailable'));
    }
    if (!payload || payload.image_id !== imageId
      || typeof payload.root_path !== 'string'
      || typeof payload.absolute_path !== 'string'
      || !path.isAbsolute(payload.root_path)
      || !path.isAbsolute(payload.absolute_path)) {
      throw new Error('Local Vilra API returned invalid file information');
    }

    const [canonicalRoot, canonicalFile] = await Promise.all([
      fs.promises.realpath(payload.root_path),
      fs.promises.realpath(payload.absolute_path),
    ]);
    const [rootStat, fileStat] = await Promise.all([
      fs.promises.stat(canonicalRoot),
      fs.promises.stat(canonicalFile),
    ]);
    const relative = path.relative(canonicalRoot, canonicalFile);
    const outsideRoot = relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative);
    if (!rootStat.isDirectory() || !fileStat.isFile() || outsideRoot) {
      throw new Error('Image file is outside the active library');
    }
    return canonicalFile;
  }

  async function openOriginal(event, imageId) {
    requireTrustedMainFrame(event);
    const absolutePath = await resolveImageFile(imageId);
    const shellError = await shell.openPath(absolutePath);
    if (shellError) throw new Error(`Could not open the original: ${shellError}`);
    return {ok: true};
  }

  async function revealImage(event, imageId) {
    requireTrustedMainFrame(event);
    const absolutePath = await resolveImageFile(imageId);
    shell.showItemInFolder(absolutePath);
    return {ok: true};
  }

  return {openOriginal, revealImage};
}

module.exports = {createNativeFileActions};
