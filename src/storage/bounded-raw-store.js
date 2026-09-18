import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { hash } from '../models/dataset.js';
const compress = promisify(gzip);
export class BoundedRawStore {
  constructor(directory, maxBytes = 256 * 1024 * 1024) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }
  async write(observation) {
    const bytes = Buffer.from(JSON.stringify(observation.payload));
    if (bytes.length > 8_000_000) throw new Error('Raw session payload exceeds bound.');
    const checksum = hash(observation.payload),
      name = checksum + '.json.gz';
    await fs.mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, name);
    try {
      await fs.access(destination);
    } catch {
      const packed = await compress(bytes);
      let used = 0;
      for (const item of await fs.readdir(this.directory)) {
        used += (await fs.stat(path.join(this.directory, item))).size;
      }
      if (used + packed.length > this.maxBytes)
        throw new Error('Raw cache budget reached; retention review required.');
      // Content-addressed, create-once files; a failure never replaces prior evidence.
      const temporary = destination + '.tmp';
      try {
        await fs.writeFile(temporary, packed, { flag: 'wx' });
        await fs.rename(temporary, destination);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
      }
    }
    return { storage: 'external-gzip', key: name, checksum, uncompressedBytes: bytes.length };
  }
}
