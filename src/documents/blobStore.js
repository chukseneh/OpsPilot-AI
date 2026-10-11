// Where uploaded files are kept (STORY-007). Each file is stored once, under its
// content fingerprint (SHA-256): uploading the same bytes again finds it already
// there and writes nothing. A file is written to a temporary name first and then
// renamed into place, so a crash or a full disk never leaves half a file under a
// real name. The database records only this reference, never the file itself.
//
// `write` and `rename` can be replaced in tests to simulate a storage failure.

import { writeFileSync, renameSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class DocumentUploadError extends Error {
  constructor(message, options) { super(message, options); this.name = 'DocumentUploadError'; }
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

export function createFileBlobStore({ dir, write = writeFileSync, rename = renameSync }) {
  const pathOf = (sha256) => {
    if (!FINGERPRINT.test(sha256)) throw new DocumentUploadError(`"${sha256}" is not a content fingerprint`);
    return join(dir, sha256);
  };

  return {
    // Returns the storage reference. Throws DocumentUploadError if it cannot be stored.
    put(sha256, bytes) {
      const path = pathOf(sha256);
      if (existsSync(path)) return `file:${sha256}`;
      const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
      try {
        mkdirSync(dir, { recursive: true });
        write(tmp, bytes, { mode: 0o600 });
        rename(tmp, path);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw new DocumentUploadError(`The file could not be stored (${err.code ?? err.message}); nothing was uploaded. Try again.`, { cause: err });
      }
      return `file:${sha256}`;
    },
    get(sha256) {
      const path = pathOf(sha256);
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    },
  };
}
