import fs from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
export const contract = JSON.parse(
  fs.readFileSync(new URL('../../docs/openapi.json', import.meta.url)),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: 'https://f1.invalid/contract', components: contract.components });
const cache = new Map();
export function validateSchema(name, data) {
  if (!cache.has(name))
    cache.set(
      name,
      ajv.compile({ $ref: `https://f1.invalid/contract#/components/schemas/${name}` }),
    );
  const validate = cache.get(name);
  return { valid: validate(data), errors: validate.errors };
}
export const validateParameter = (schema) => ajv.compile(schema);
export const operations = Object.entries(contract.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({ path, method, ...op })),
);
export function shape(name) {
  const visit = (s) => {
    if (s.$ref) return visit(contract.components.schemas[s.$ref.split('/').at(-1)]);
    if (s.anyOf?.some((x) => x.type === 'null')) return null;
    if (s.type === 'array') return [];
    if (s.type === 'object')
      return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, visit(v)]));
    return null;
  };
  return visit(contract.components.schemas[name]);
}
