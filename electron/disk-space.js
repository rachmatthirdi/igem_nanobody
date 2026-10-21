// Free-space check before the tools image is downloaded.
//
// The image is about 19 GB to download and about 53 GB on disk once Docker has
// unpacked it (see README). Without a check, a host with too little room only
// finds out when the unpack fails partway through the download. This module is
// kept free of Electron so it can be tested on its own.

const fs = require("fs");

const GB = 1024 ** 3;

// About 53 GB on disk, plus a little room for the layers Docker holds while it
// unpacks them.
const IMAGE_DISK_BYTES = 55 * GB;

// Free bytes for an unprivileged user on the file system that holds `dir`.
//
// Best effort: when the answer can't be determined it returns `checked: false`
// and `ok: true`, so the download is never blocked on a guess. That is the case
// for Docker Desktop on macOS and Windows, where DockerRootDir is a path inside
// the Docker VM and does not exist on the host.
//
// `statfs` is a parameter only so tests can stand in for the file system.
async function checkFreeSpace(
  dir,
  needBytes = IMAGE_DISK_BYTES,
  statfs = fs.promises.statfs,
) {
  if (!dir) return { checked: false, ok: true, dir: null };
  let st;
  try {
    st = await statfs(dir);
  } catch {
    return { checked: false, ok: true, dir };
  }
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  if (!Number.isFinite(freeBytes)) return { checked: false, ok: true, dir };
  return { checked: true, ok: freeBytes >= needBytes, freeBytes, needBytes, dir };
}

function formatGb(bytes) {
  const gb = bytes / GB;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

// Worded to name the numbers and the place, so the user knows which disk to
// clear. Avoids the phrases that renderer/js/messages.js turns into other,
// less specific explanations.
function shortfallMessage(result) {
  return (
    `Not enough disk space to download the Docker image. It needs about ` +
    `${formatGb(result.needBytes)} free, and only ${formatGb(result.freeBytes)} ` +
    `is free where Docker stores its data (${result.dir}). Free some space and ` +
    `try again.`
  );
}

module.exports = { IMAGE_DISK_BYTES, checkFreeSpace, formatGb, shortfallMessage };
