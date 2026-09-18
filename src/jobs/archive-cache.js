import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../models/dataset.js';

// Only public upstream responses are cached. Successful pages are immutable within a run.
export class ArchiveCache {
  constructor(directory, upstream) {
    this.directory = directory;
    this.upstream = upstream;
  }
  async get(key) {
    const file = path.join(this.directory, hash(key) + '.json');
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.key !== key || saved.checksum !== hash(saved.response))
        throw new Error('Archive cache checksum mismatch.');
      return saved.response;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const response = await this.upstream.get(key);
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ key, checksum: hash(response), response }));
    await fs.rename(temporary, file);
    return response;
  }
}
