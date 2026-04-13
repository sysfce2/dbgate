const yauzl = require('yauzl');
const fs = require('fs');
const path = require('path');
const { getLogger, extractErrorLogData } = require('dbgate-tools');

const logger = getLogger('unzipDirectory');

/**
 * Extracts an entire ZIP file, preserving its internal directory layout.
 *
 * @param {string} zipPath          Path to the ZIP file on disk.
 * @param {string} outputDirectory  Folder to create / overwrite with the contents.
 * @returns {Promise<boolean>}      Resolves `true` on success, rejects on error.
 */
function unzipDirectory(zipPath, outputDirectory) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipFile) => {
      if (err) return reject(err);

      /** Pending per-file extractions – we resolve the main promise after they’re all done */
      const pending = [];

      // Resolved output boundary used for zip-slip checks on every entry
      const resolvedOutputDir = path.resolve(outputDirectory);

      // kick things off
      zipFile.readEntry();

      zipFile.on('entry', entry => {
        // Null-byte poison check
        if (entry.fileName.includes('\0')) {
          return reject(new Error(`DBGM-00000 ZIP entry with null byte in filename rejected`));
        }

        const destPath = path.join(outputDirectory, entry.fileName);
        const resolvedDest = path.resolve(destPath);

        // Zip-slip protection: every extracted path must stay inside outputDirectory
        if (resolvedDest !== resolvedOutputDir && !resolvedDest.startsWith(resolvedOutputDir + path.sep)) {
          return reject(
            new Error(`DBGM-00000 ZIP slip detected: entry "${entry.fileName}" would escape output directory`)
          );
        }

        // Handle directories (their names always end with “/” in ZIPs)
        if (/\/$/.test(entry.fileName)) {
          // Ensure directory exists, then continue to next entry
          fs.promises
            .mkdir(destPath, { recursive: true })
            .then(() => zipFile.readEntry())
            .catch(reject);
          return;
        }

        // Handle files
        const filePromise = fs.promises
          .mkdir(path.dirname(destPath), { recursive: true }) // make sure parent dirs exist
          .then(
            () =>
              new Promise((res, rej) => {
                zipFile.openReadStream(entry, (err, readStream) => {
                  if (err) return rej(err);

                  const writeStream = fs.createWriteStream(destPath);
                  readStream.pipe(writeStream);

                  // proceed to next entry once we’ve consumed *this* one
                  readStream.on('end', () => zipFile.readEntry());

                  writeStream.on('finish', () => {
                    logger.info(`DBGM-00068 Extracted "${entry.fileName}" → "${destPath}".`);
                    res();
                  });

                  writeStream.on('error', writeErr => {
                    logger.error(
                      extractErrorLogData(writeErr),
                      `DBGM-00069 Error extracting "${entry.fileName}" from "${zipPath}".`
                    );
                    rej(writeErr);
                  });
                });
              })
          );

        pending.push(filePromise);
      });

      // Entire archive enumerated; wait for all streams to finish
      zipFile.on('end', () => {
        Promise.all(pending)
          .then(() => {
            logger.info(`DBGM-00070 Archive "${zipPath}" fully extracted to "${outputDirectory}".`);
            resolve(true);
          })
          .catch(reject);
      });

      zipFile.on('error', err => {
        logger.error(extractErrorLogData(err), `DBGM-00071 ZIP file error in ${zipPath}.`);
        reject(err);
      });
    });
  });
}

module.exports = unzipDirectory;
