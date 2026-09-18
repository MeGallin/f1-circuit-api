import { randomUUID } from 'node:crypto';
import { hash, dataset } from '../models/dataset.js';
import { normalizeWeekend } from '../models/normalization.js';
import { validateSchema } from '../schemas/contract.js';
import { reconcileDataset } from '../reconciliation/datasets.js';
export class SyncService {
  constructor(repository) {
    this.repository = repository;
  }
  async publishSeasonCatalogue(bundle) {
    const current = await this.repository.snapshot();
    const previous = current ? await this.repository.get('seasons', current.id) : null;
    const existing = new Map((previous?.items || []).map((row) => [row.year, row]));
    const yearNow = new Date().getUTCFullYear();
    const items = bundle.records
      .map((record) => {
        if (!/^\d{4}$/.test(record.season) || Number(record.season) < 1950)
          throw new Error('Invalid provider season.');
        const year = Number(record.season);
        return {
          ...(existing.get(year) || {
            id: `season:${year}`,
            evidenceId: null,
            year,
            eventCount: 0,
            completedCount: 0,
            coverage: 'unavailable',
          }),
          isCurrent: year === yearNow,
        };
      })
      .sort((a, b) => b.year - a.year);
    if (!items.length) throw new Error('Cannot publish an empty provider catalogue.');
    const set = dataset(
      'seasons',
      'Season',
      items,
      {
        retrievedAt: bundle.observations.at(-1)?.retrievedAt || new Date().toISOString(),
        sources: [
          {
            id: 'jolpica',
            name: 'jolpica',
            url: 'https://api.jolpi.ca/ergast/f1/seasons/',
            attribution: 'Jolpica F1 / Ergast contributors',
            version: null,
          },
        ],
      },
      {
        coverage: 'complete',
        warnings: [
          {
            code: 'CATALOGUE_NOT_EVENT_COVERAGE',
            message:
              'This provider season index includes seasons whose event data has not been imported. Season counts describe imported calendar records, not the total races held.',
            scope: 'seasons',
          },
        ],
      },
    );
    return this.publishSets(
      { sets: [set], aliases: Object.fromEntries(items.map((row) => [row.id, row.id])) },
      bundle.observations,
      'jolpica',
    );
  }
  async publish(bundle, provider, version = null) {
    const current = await this.repository.snapshot();
    if (current) {
      bundle.eventIds = {};
      for (const race of bundle.calendar) {
        const alias = await this.repository.resolve(
          `race:${race.season}:${race.round}`,
          current.id,
        );
        if (!alias) continue;
        const prior = await this.repository.get(`event:${alias}`, current.id);
        if (prior && prior.items[0].event.circuit.id !== `circuit:${race.Circuit.circuitId}`)
          throw new Error(
            'Existing event circuit differs; reviewed source identity mapping is required.',
          );
        bundle.eventIds[race.round] = alias;
      }
    }
    const retrievedAt = new Date().toISOString();
    const sources = [
      {
        id: provider,
        name: provider,
        url:
          provider === 'jolpica'
            ? 'https://api.jolpi.ca/ergast/f1/'
            : 'https://github.com/f1db/f1db',
        attribution:
          provider === 'jolpica'
            ? 'Jolpica F1 / Ergast contributors'
            : 'F1DB contributors — CC BY 4.0',
        version,
      },
    ];
    const normalized = normalizeWeekend(bundle, { retrievedAt, sources });
    return this.publishSets(normalized, bundle.observations || [], provider, version);
  }
  async publishSets(normalized, observations, provider, version = null) {
    const repo = this.repository;
    const current = await repo.snapshot();
    // Merge imported seasons into the catalogue; do not discard previously imported years.
    const season = normalized.sets.find((s) => s.key === 'seasons');
    if (season && current) {
      const previous = await repo.get('seasons', current.id);
      const incoming = new Map((previous?.items || []).map((r) => [r.id, r]));
      season.items.forEach((r) => incoming.set(r.id, r));
      season.items = [...incoming.values()].sort((a, b) => b.year - a.year);
    }
    for (const set of normalized.sets) {
      const ids = new Set();
      for (const row of set.items) {
        const validation = validateSchema(set.schema, row);
        if (!validation.valid)
          throw new Error(
            `Normalized ${set.schema} failed schema validation: ${JSON.stringify(validation.errors)}`,
          );
        if (row.id && ids.has(row.id)) throw new Error('Duplicate normalized identity.');
        ids.add(row.id);
      }
      if (current) {
        const previous = await repo.get(set.key, current.id);
        if (set.key.startsWith('events:') && previous) {
          const old = new Map(previous.items.map((r) => [r.id, r]));
          set.items = set.items.map((r) =>
            old.get(r.id)?.status === 'completed' && r.status === 'unknown'
              ? { ...r, status: 'completed' }
              : r,
          );
        }
        if (
          /^standings:\d+:(drivers|constructors)$/.test(set.key) &&
          previous?.items.length &&
          set.items.length
        ) {
          const oldRound = Number(previous.items[0].standingSnapshotId.split(':').at(-1));
          const newRound = Number(set.items[0].standingSnapshotId.split(':').at(-1));
          if (oldRound > newRound) {
            Object.assign(set, previous);
          }
        }
        if (previous?.items.length && set.items.length) {
          Object.assign(set, reconcileDataset(previous, set));
        }
        if (previous?.items.length && set.items.length === 0) {
          set.items = previous.items;
          set.verification = previous.verification;
          set.coverage = 'partial';
          set.provenance = previous.provenance;
          set.evidenceId = previous.evidenceId;
          set.warnings.push({
            code: 'RETAINED_SNAPSHOT',
            message: 'Last successful data retained after unavailable import.',
            scope: set.key,
          });
        }
      }
    }
    if (season) {
      for (const row of season.items) {
        const events = normalized.sets.find((s) => s.key === `events:${row.year}`);
        if (events)
          row.completedCount = events.items.filter((e) => e.status === 'completed').length;
      }
    }
    for (const o of observations)
      await repo.observation({
        id: hash([provider, o.url, o.payload]),
        provider,
        version,
        retrievedAt: o.retrievedAt,
        checksum: o.checksum || hash(o.payload),
        url: o.url,
        payload: o.payload,
      });
    const now = new Date().toISOString();
    const priorStatus = current ? await repo.get(`source:${provider}`, current.id) : null;
    const capabilities = new Map(
      (priorStatus?.items[0]?.capabilities || []).map((item) => [item.key, item]),
    );
    for (const set of normalized.sets)
      capabilities.set(set.key, {
        key: set.key,
        coverage: set.coverage,
        reasonCode: null,
        endpoint: null,
      });
    normalized.sets.push(
      dataset(
        `source:${provider}`,
        'ProviderStatus',
        [
          {
            id: provider,
            evidenceId: null,
            name: provider,
            enabled: true,
            health: normalized.sets.some((x) => x.coverage === 'unavailable')
              ? 'degraded'
              : 'healthy',
            lastSuccess: now,
            lastFailure: null,
            capabilities: [...capabilities.values()],
          },
        ],
        { retrievedAt: now, sources: [] },
        { coverage: 'complete' },
      ),
    );
    return repo.publish(normalized.sets, normalized.aliases || {}, {
      provider,
      version,
      jobId: randomUUID(),
    });
  }
}
