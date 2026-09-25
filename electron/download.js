// Single-file downloader with byte-level progress, redirect following and a
// completeness check. Kept out of main.js so it can be exercised directly by a
// test against a local server, without starting Electron.
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatMB(bytes) {
  return (bytes / 1e6).toFixed(1);
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Downloads `url` to `destPath`, writing to a `.part` file that is only
 * promoted once the transfer is verifiably complete.
 *
 * opts.allowInsecure exists for tests against a local plain-http server; the
 * app never sets it.
 */
function downloadFileWithProgress({
  url,
  destPath,
  label = "file",
  maxRedirects = 5,
  onProgress = () => {},
  onLog = () => {},
  allowInsecure = false,
}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part`;
    const startedAt = Date.now();
    let lastEmit = 0;
    let file = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (file) file.close();
      // Never leave a .part behind, and never promote one: ensureRf2Weights()
      // only checks that the final path exists, so anything that lands there
      // is trusted for the lifetime of the install.
      fs.unlink(tmpPath, () => {});
      reject(err);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const get = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        fail(new Error(`Invalid download URL: ${currentUrl}`));
        return;
      }
      // Weight files get loaded straight into a torch process, so a redirect
      // that downgrades to plaintext http is refused rather than followed.
      if (parsed.protocol !== "https:" && !allowInsecure) {
        fail(
          new Error(
            `Refusing to download ${label} over ${parsed.protocol}// - only https is allowed.`,
          ),
        );
        return;
      }
      const client = parsed.protocol === "https:" ? https : http;

      client
        .get(currentUrl, (res) => {
          // Follow redirects. Without this a single 301/302 on the upstream
          // file server turned into five failed retries and a dead install,
          // since anything other than 200 was treated as fatal.
          if (REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
            res.resume(); // drain so the socket can be reused
            if (redirectsLeft <= 0) {
              fail(
                new Error(
                  `Too many redirects (>${maxRedirects}) downloading ${label}.`,
                ),
              );
              return;
            }
            let next;
            try {
              next = new URL(res.headers.location, currentUrl).toString();
            } catch {
              fail(
                new Error(
                  `Unusable redirect target for ${label}: ${res.headers.location}`,
                ),
              );
              return;
            }
            onLog(`${label}: redirected to ${next}`);
            get(next, redirectsLeft - 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            fail(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
            return;
          }

          const total = parseInt(res.headers["content-length"], 10) || 0;
          let received = 0;
          file = fs.createWriteStream(tmpPath);
          file.on("error", fail);

          res.on("data", (chunk) => {
            received += chunk.length;
            const now = Date.now();
            if (now - lastEmit < 400) return;
            lastEmit = now;
            const elapsed = (now - startedAt) / 1000;
            const rate = received / elapsed;
            const eta = rate > 0 && total > 0 ? (total - received) / rate : NaN;
            const percent =
              total > 0 ? Math.min(99, (received / total) * 100) : 0;
            onProgress(
              percent,
              `Downloading ${label}: ${percent.toFixed(0)}% (${formatMB(received)}MB/${formatMB(total)}MB)` +
                (isFinite(eta) ? ` — ${formatEta(eta)} remaining` : ""),
            );
          });
          res.on("error", fail);

          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              // A connection dropped mid-transfer can still end cleanly: no
              // 'error' fires, the stream just stops short. Renaming that into
              // place left a truncated weight file that was then skipped on
              // every later run, so RF2 kept failing with nothing pointing at
              // the cause. Check the size before promoting the file.
              if (total > 0 && received !== total) {
                fs.unlink(tmpPath, () => {});
                if (settled) return;
                settled = true;
                reject(
                  new Error(
                    `${label} download ended early: received ${formatMB(received)}MB of ${formatMB(total)}MB. Partial file discarded.`,
                  ),
                );
                return;
              }
              try {
                fs.renameSync(tmpPath, destPath);
              } catch (e) {
                fail(e);
                return;
              }
              done();
            });
          });
        })
        .on("error", fail);
    };

    get(url, maxRedirects);
  });
}

module.exports = {
  downloadFileWithProgress,
  formatEta,
  formatMB,
  REDIRECT_CODES,
};
