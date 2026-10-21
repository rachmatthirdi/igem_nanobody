// Tests for electron/disk-space.js, the free-space check made before the tools
// image is downloaded. The file system is replaced by a fake `statfs`, so the
// tests need no Docker and no particular amount of free disk.
//
// Run from the repository root:  node tests/disk-space.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  IMAGE_DISK_BYTES,
  checkFreeSpace,
  formatGb,
  shortfallMessage,
} = require("../electron/disk-space.js");

const GB = 1024 ** 3;
const fakeStatfs = (freeGb) => async () => ({ bavail: freeGb * 256, bsize: GB / 256 });

test("the requirement covers the ~53 GB image with a little margin", () => {
  assert.ok(IMAGE_DISK_BYTES >= 53 * GB);
  assert.ok(IMAGE_DISK_BYTES <= 60 * GB);
});

test("passes when there is more free space than needed", async () => {
  const r = await checkFreeSpace("/var/lib/docker", IMAGE_DISK_BYTES, fakeStatfs(120));
  assert.equal(r.checked, true);
  assert.equal(r.ok, true);
  assert.equal(r.freeBytes, 120 * GB);
});

test("passes when free space exactly equals the requirement", async () => {
  const r = await checkFreeSpace("/d", IMAGE_DISK_BYTES, fakeStatfs(55));
  assert.equal(r.ok, true);
});

test("fails when there is less free space than needed", async () => {
  const r = await checkFreeSpace("/var/lib/docker", IMAGE_DISK_BYTES, fakeStatfs(18));
  assert.equal(r.checked, true);
  assert.equal(r.ok, false);
  assert.equal(r.freeBytes, 18 * GB);
  assert.equal(r.dir, "/var/lib/docker");
});

test("never blocks when the path cannot be read", async () => {
  const missing = async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const r = await checkFreeSpace("/var/lib/docker", IMAGE_DISK_BYTES, missing);
  assert.deepEqual([r.checked, r.ok], [false, true]);
});

test("never blocks when Docker's data directory is unknown", async () => {
  for (const dir of [null, undefined, ""]) {
    const r = await checkFreeSpace(dir, IMAGE_DISK_BYTES, fakeStatfs(1));
    assert.deepEqual([r.checked, r.ok], [false, true]);
  }
});

test("never blocks on a nonsensical answer", async () => {
  const r = await checkFreeSpace("/d", IMAGE_DISK_BYTES, async () => ({ bavail: NaN, bsize: 4096 }));
  assert.deepEqual([r.checked, r.ok], [false, true]);
});

test("reads the real file system", async () => {
  const r = await checkFreeSpace(".", 1);
  assert.equal(r.checked, true);
  assert.equal(r.ok, true);
  assert.ok(r.freeBytes > 0);
});

test("formats sizes without false precision", () => {
  assert.equal(formatGb(53 * GB), "53 GB");
  assert.equal(formatGb(18.4 * GB), "18 GB");
  assert.equal(formatGb(2.55 * GB), "2.5 GB");
});

test("the message names the amounts and the place to clear", async () => {
  const r = await checkFreeSpace("/var/lib/docker", IMAGE_DISK_BYTES, fakeStatfs(18));
  const msg = shortfallMessage(r);
  assert.match(msg, /55 GB/);
  assert.match(msg, /18 GB/);
  assert.match(msg, /\/var\/lib\/docker/);
});

test("the message avoids phrases that messages.js rewrites into generic text", async () => {
  const r = await checkFreeSpace("/d", IMAGE_DISK_BYTES, fakeStatfs(1));
  const msg = shortfallMessage(r);
  assert.doesNotMatch(msg, /tools image|image isn't built|network|cancell?ed by user/i);
});
