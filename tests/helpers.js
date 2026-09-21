import { normalizeWeekend } from '../src/models/normalization.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { createApp } from '../src/app.js';
import { createRouter } from '../src/routes/index.js';
export class MemoryRepository {
  constructor() {
    const result = normalizeWeekend(syntheticWeekend(), {
      retrievedAt: '2024-01-02T00:00:00Z',
      sources: [
        {
          id: 'synthetic',
          name: 'Synthetic test source',
          url: 'https://example.invalid',
          attribution: 'Fictional fixture; not race facts',
          version: '1',
        },
      ],
    });
    this.sets = new Map(result.sets.map((s) => [s.key, s]));
    this.aliases = result.aliases;
    this.id = 'synthetic-publication';
  }
  async ready() {
    return true;
  }
  async snapshot(id) {
    return !id || id === this.id ? { id: this.id } : null;
  }
  async get(key) {
    return this.sets.get(key) || null;
  }
  async keys(prefix) {
    return [...this.sets.keys()].filter((k) => k.startsWith(prefix));
  }
  async resolve(key) {
    return this.aliases[key] || null;
  }
  async evidence(id) {
    return [...this.sets.values()].find((s) => s.evidenceId === id) || null;
  }
  async observation() {}
  async publish(sets, aliases) {
    sets.forEach((s) => this.sets.set(s.key, s));
    Object.assign(this.aliases, aliases);
    return this.id;
  }
}
export const eventId = 'event:2024:synthetic-grand-prix';
export const sessionId = `session:${eventId}:race`;
export function appFixture(repository = new MemoryRepository()) {
  return {
    repository,
    app: createApp({
      repository,
      router: createRouter(repository),
      config: { origins: ['https://f1.livenotice.co.uk', 'http://localhost:5173'] },
      logger: { info() {}, error() {} },
    }),
  };
}
export function exampleRequest(operation, repository) {
  const ids = {
    year: 2024,
    round: 1,
    kind: 'drivers',
    eventId,
    sessionId,
    id: operation.path.startsWith('/constructors')
      ? 'constructor:example-team'
      : operation.path.startsWith('/circuits')
        ? 'circuit:example-circuit'
        : 'driver:example-one',
    evidenceId: [...repository.sets.values()][0].evidenceId,
  };
  if (operation.operationId === 'getQualifying') ids.sessionId = `session:${eventId}:qualifying`;
  const query = {};
  for (const p of operation.parameters.filter((p) => p.in === 'query' && p.required))
    query[p.name] =
      p.schema.enum?.[0] ||
      {
        q: 'Example',
        entityId: 'driver:example-one',
        driverId: 'driver:example-one',
        leftId: 'driver:example-one',
        rightId: 'driver:example-two',
        fromYear: 2024,
        toYear: 2024,
        from: '2024-01-01T12:00:00Z',
        to: '2024-01-01T12:01:00Z',
      }[p.name];
  return {
    path:
      '/api/v1' + operation.path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(ids[key])),
    query,
    body: {
      text: 'Who won?',
      context: { year: 2024, eventId, sessionId, driverId: null, constructorId: null },
    },
  };
}
