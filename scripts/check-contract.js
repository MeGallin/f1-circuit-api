import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import SwaggerParser from '@apidevtools/swagger-parser';
const url = new URL('../docs/openapi.json', import.meta.url);
await SwaggerParser.validate(url.pathname.replace(/^\/([A-Z]:)/, '$1'));
const manifest = JSON.parse(
  await fs.readFile(new URL('../docs/contract-manifest.json', import.meta.url), 'utf8'),
);
const checksum = crypto
  .createHash('sha256')
  .update(await fs.readFile(url))
  .digest('hex');
if (checksum !== manifest.openapiSha256) throw new Error('Contract manifest checksum mismatch.');
console.log('OpenAPI structure and pinned checksum verified.');
