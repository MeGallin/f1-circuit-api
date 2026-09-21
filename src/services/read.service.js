import { ApiError, invalid, missing } from '../errors/api-error.js';
import { meta, hash } from '../models/dataset.js';
const keyMap = {
  getClassification: 'results',
  getQualifying: 'qualifying',
  getLap: 'laps',
  getPitStop: 'pit-stops',
  getStint: 'stints',
  getWeather: 'weather',
  getRaceControl: 'race-control',
  getPenalty: 'penalties',
  getPosition: 'positions',
  getInterval: 'intervals',
  getOvertake: 'overtakes',
  getRadio: 'radio',
  getTelemetry: 'telemetry',
  getLocation: 'locations',
};

// Older publications predate the nullable driver-number field. Normalize that
// legacy shape at the read boundary so historical seasons still satisfy the
// current response contract without rewriting the stored publication.
const normalizeStandingSet = (set) =>
  set
    ? {
        ...set,
        items: set.items.map((row) => ({
          ...row,
          number: row.number == null || row.number === '' ? null : String(row.number),
        })),
      }
    : set;

export class ReadService {
  constructor(repository, questionService = null) {
    this.repository = repository;
    this.questionService = questionService;
  }
  async read(operation, { params: p, query: q, body }) {
    let cursor = null;
    if (q.cursor) {
      try {
        if (q.cursor.length > 2048) throw new Error();
        cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
        if (
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          typeof cursor.snapshot !== 'string'
        )
          throw new Error();
      } catch {
        throw invalid('Invalid cursor.');
      }
    }
    if (q.snapshotId && cursor && q.snapshotId !== cursor.snapshot)
      throw invalid('Cursor and snapshot disagree.');
    const snapshot = await this.repository.snapshot(q.snapshotId || cursor?.snapshot);
    if (!snapshot)
      throw new ApiError(
        q.snapshotId || cursor ? 409 : 503,
        q.snapshotId || cursor ? 'SNAPSHOT_EXPIRED' : 'SERVICE_UNAVAILABLE',
        q.snapshotId || cursor
          ? 'Restart this view using a current snapshot.'
          : 'No imported publication is available.',
      );
    const repo = this.repository;
    const get = (key) => repo.get(key, snapshot.id);
    const keys = (prefix) => repo.keys(prefix, snapshot.id);
    const aggregate = async (prefix, predicate = () => true, keyFilter = () => true) => {
      const sets = await Promise.all((await keys(prefix)).filter(keyFilter).map(get));
      const items = sets.flatMap((s) => s.items).filter(predicate);
      return {
        items,
        coverage: items.length ? 'partial' : 'unavailable',
        verification: sets.some((s) => s.verification === 'conflict') ? 'conflict' : 'source-only',
        provenance: sets[0]?.provenance,
        evidenceId: sets[0]?.evidenceId,
        warnings: sets.flatMap((s) => s.warnings || []),
      };
    };
    const need = async (key) => {
      const set = await get(key);
      if (!set) throw missing();
      return set;
    };
    let set;
    const op = operation.operationId;
    if (p.year || q.year) {
      const seasons = await get('seasons');
      if (!seasons?.items.some((s) => s.year === (p.year || q.year))) throw missing();
    }
    if (p.sessionId) {
      if (!(await repo.resolve(p.sessionId, snapshot.id))) throw missing();
    }
    if (op === 'listSeasons') {
      set = await get('seasons');
      if (set)
        set = {
          ...set,
          items: set.items
            .map((row) => ({ ...row, isCurrent: row.year === new Date().getUTCFullYear() }))
            .sort((a, b) => b.year - a.year),
        };
    } else if (op === 'getCalendar') set = await get(`events:${p.year}`);
    else if (op === 'getSeasonSummary') {
      const seasons = await need('seasons'),
        events = await get(`events:${p.year}`);
      const all = events?.items || [];
      const ds = normalizeStandingSet(await get(`standings:${p.year}:drivers`)),
        cs = normalizeStandingSet(await get(`standings:${p.year}:constructors`));
      set = {
        ...events,
        items: [
          {
            season: seasons.items.find((s) => s.year === p.year),
            nextEvent:
              all
                .filter((e) => e.status === 'scheduled')
                .sort((a, b) => (a.schedule.date || '').localeCompare(b.schedule.date || ''))[0] ||
              null,
            latestCompletedEvent:
              all.filter((e) => e.status === 'completed').sort((a, b) => b.round - a.round)[0] ||
              null,
            standingSnapshotId:
              ds?.items[0]?.standingSnapshotId || cs?.items[0]?.standingSnapshotId || null,
            leadingDrivers: ds?.items.slice(0, 10) || [],
            leadingConstructors: cs?.items.slice(0, 10) || [],
          },
        ],
      };
    } else if (op === 'getEvent' || op === 'lookupRace' || op === 'getImpact') {
      const id = p.eventId || (await repo.resolve(`race:${p.year}:${p.round}`, snapshot.id));
      if (!id) throw missing();
      set = await get(`event:${id}`);
      if (!set) {
        const events = await aggregate('events:', (e) => e.id === id);
        if (!events.items.length) throw missing();
        set = {
          ...events,
          items: [
            {
              event: events.items[0],
              sessions: [],
              podium: [],
              winner: null,
              fastestLap: null,
              metrics: [],
            },
          ],
        };
      }
      if (op === 'getImpact')
        set = {
          ...set,
          items: [],
          coverage: 'unavailable',
          warnings: [
            {
              code: 'SCORING_ATTRIBUTION_PENDING',
              message: 'An audited before/after scoring breakdown is not yet available.',
              scope: 'standings-impact',
            },
          ],
        };
    } else if (op === 'getStandings') {
      let round = q.round;
      if (q.standingSnapshotId) {
        const match = q.standingSnapshotId.match(/^standing:(\d+):(\d+)$/);
        if (!match || Number(match[1]) !== p.year)
          throw invalid('Standing snapshot does not belong to this season.');
        round = Number(match[2]);
      }
      set = normalizeStandingSet(
        await get(`standings:${p.year}:${p.kind}${round ? ':' + round : ''}`),
      );
    } else if (op === 'getProgression') {
      set = await aggregate(`standings:${p.year}:${p.kind}:`, (r) => r.entity.id === q.entityId);
      set.items = set.items
        .map((r) => ({
          id: r.id,
          evidenceId: r.evidenceId,
          entityId: r.entity.id,
          round: Number(r.standingSnapshotId.split(':').at(-1)),
          sessionId: null,
          standingSnapshotId: r.standingSnapshotId,
          points: r.points,
          rank: r.rank,
        }))
        .filter(
          (r) =>
            (q.fromRound === undefined || r.round >= q.fromRound) &&
            (q.toRound === undefined || r.round <= q.toRound),
        )
        .sort((a, b) => a.round - b.round);
    } else if (keyMap[op]) set = await get(`${keyMap[op]}:${p.sessionId}`);
    else if (op.endsWith('Profile')) {
      set = await need(`profile:${p.id}`);
      if (set.items[0]?.kind !== op.slice(3, -7)) throw missing();
    } else if (op.endsWith('History')) {
      const profile = await need(`profile:${p.id}`);
      if (profile.items[0]?.kind !== op.slice(3, -7)) throw missing();
      const historySessions = new Map();
      const sessionKeys = (await keys('sessions:')).filter(
        (key) => !q.year || key.includes(`event:${q.year}:`),
      );
      const sessionSets = await Promise.all(sessionKeys.map(get));
      for (const sessionSet of sessionSets) {
        for (const session of sessionSet?.items || []) historySessions.set(session.id, session);
      }
      set =
        op === 'getcircuitHistory'
          ? await aggregate(
              'events:',
              (r) => r.circuit?.id === p.id && (!q.year || r.year === q.year),
            )
          : await aggregate(
              'results:',
              (r) =>
                op === 'getdriverHistory'
                  ? r.entry.drivers.some((d) => d.id === p.id)
                  : r.entry.constructor?.id === p.id,
              (key) => !q.year || key.includes(`event:${q.year}:`),
            );
      if (q.year && op !== 'getcircuitHistory') {
        const events = await get(`events:${q.year}`);
        const eventIds = new Set((events?.items || []).map((e) => e.id));
        const sessionIds = new Set(
          [...historySessions.values()]
            .filter((session) => eventIds.has(session.eventId))
            .map((session) => session.id),
        );
        set.items = set.items.filter((r) => sessionIds.has(r.sessionId));
      }
      if (op !== 'getcircuitHistory') {
        const historyEventIds = new Set(
          set.items.map((row) => historySessions.get(row.sessionId)?.eventId).filter(Boolean),
        );
        const historyEvents = new Map();
        const eventSets = await Promise.all(
          [...historyEventIds].map((eventId) => get(`event:${eventId}`)),
        );
        for (const eventSet of eventSets) {
          const event = eventSet?.items?.[0]?.event;
          if (event) historyEvents.set(event.id, event);
        }
        set.items = set.items.map((row) => {
          const session = historySessions.get(row.sessionId);
          const event = session ? historyEvents.get(session.eventId) : null;
          return {
            ...row,
            eventContext: event && session ? { event, session } : null,
          };
        });
      }
    } else if (op === 'getLayouts') {
      const profile = await need(`profile:${p.id}`);
      if (profile.items[0]?.kind !== 'circuit') throw missing();
      set = await get(`layouts:${p.id}`);
    } else if (op === 'search') {
      const profiles = await aggregate('profile:');
      const events = await aggregate('events:');
      const seasons = await get('seasons');
      const items = [
        ...profiles.items.map((r) => ({
          id: r.id,
          evidenceId: r.evidenceId,
          kind: r.kind,
          entity: r.entity,
          context: null,
        })),
        ...events.items.map((r) => ({
          id: r.id,
          evidenceId: r.evidenceId,
          kind: 'event',
          entity: {
            id: r.id,
            displayName: r.name,
            clientPath: `/events/${encodeURIComponent(r.id)}`,
          },
          context: String(r.year),
        })),
        ...(seasons?.items || []).map((r) => ({
          id: r.id,
          evidenceId: r.evidenceId,
          kind: 'season',
          entity: { id: r.id, displayName: String(r.year), clientPath: `/seasons/${r.year}` },
          context: null,
        })),
      ];
      const terms = q.q
        .trim()
        .toLowerCase()
        .split(/[\s,+]+/)
        .filter(Boolean);
      const matchesSearch = (value) => terms.some((term) => value.toLowerCase().includes(term));
      set = {
        ...profiles,
        items: items.filter(
          (r) =>
            (!q.kind || r.kind === q.kind) &&
            [r.entity.displayName, r.id, r.entity.id].some((value) => matchesSearch(value)),
        ),
      };
    } else if (op === 'getSources') set = await aggregate('source:');
    else if (op === 'getEvidence') {
      const source = await repo.evidence(p.evidenceId, snapshot.id);
      if (!source) throw missing();
      const fields = [];
      function visit(value, path) {
        if (value && typeof value === 'object') {
          for (const [key, v] of Object.entries(value))
            if (key !== 'evidenceId')
              visit(v, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        } else
          fields.push({
            path,
            verification: source.verification,
            coverage: source.coverage,
            reasonCode: value === null ? 'SOURCE_FIELD_UNAVAILABLE' : null,
            selectedValue: value,
            selectionReason: 'Source-specific normalized assertion',
            ruleVersion: null,
            assertions: (source.provenance?.sources || []).slice(0, 1).map((s) => ({
              sourceId: s.id,
              value,
              retrievedAt: source.provenance.retrievedAt,
              sourceVersion: s.version,
              lineageGroup: s.id,
              referenceUrl: s.url,
            })),
          });
      }
      source.items.forEach((item, i) => visit(item, `/items/${i}`));
      for (const comparison of source.fieldComparisons || []) {
        const index = fields.findIndex((f) => f.path === comparison.path);
        if (index >= 0) fields[index] = comparison;
        else fields.push(comparison);
      }
      set = {
        ...source,
        items: [
          {
            id: p.evidenceId,
            evidenceId: p.evidenceId,
            snapshotId: snapshot.id,
            resourceId: source.key,
            fields,
            derivationVersion: null,
          },
        ],
      };
    } else if (op === 'askQuestion') {
      if (!this.questionService)
        set = {
          items: [
            {
              status: 'unavailable',
              message: 'The optional question layer is outside this API build.',
              reasonCode: 'FEATURE_DISABLED',
            },
          ],
          coverage: 'not-applicable',
          verification: 'unassessed',
          provenance: { sources: [] },
          warnings: [],
        };
      else {
        const question = await this.questionService.answer(body, { snapshot, get, keys });
        set = { ...question.dataset, items: [question.result] };
      }
    } else if (op === 'getComparison') {
      const kind = q.kind;
      if (kind === 'circuit' && q.metric === 'points')
        throw invalid('Championship points cannot be attributed to a circuit.');
      const requireEntity = async (id) => {
        if (kind === 'season') {
          const seasons = await get('seasons');
          if (!seasons?.items.some((row) => row.id === id)) throw missing();
        } else {
          const profile = await need(`profile:${id}`);
          if (profile.items[0]?.kind !== kind)
            throw invalid('Entity does not match the selected kind.');
        }
      };
      await requireEntity(q.leftId);
      await requireEntity(q.rightId);
      set = {
        items: [],
        coverage: 'unavailable',
        verification: 'unassessed',
        warnings: [
          {
            code: 'HISTORICAL_METRIC_NOT_QUALIFIED',
            message: 'This metric requires audited historical credit and scoring rules.',
            scope: op,
          },
        ],
      };
    }
    if (!set)
      set = {
        items: [],
        coverage: 'unavailable',
        verification: 'unassessed',
        warnings: [
          {
            code: 'SOURCE_COVERAGE_UNAVAILABLE',
            message: 'This dataset has not been imported for this scope.',
            scope: op,
          },
        ],
      };
    let items = set.items;
    if (q.driverId) {
      let entryIds = new Set();
      if (p.sessionId) {
        const entries = await get(`results:${p.sessionId}`);
        entryIds = new Set(
          (entries?.items || [])
            .filter((r) => r.entry.drivers.some((d) => d.id === q.driverId))
            .map((r) => r.entry.id),
        );
      }
      items = items.filter(
        (r) =>
          r.entry?.drivers.some((d) => d.id === q.driverId) ||
          entryIds.has(r.entryId) ||
          r.entryIds?.some((id) => entryIds.has(id)),
      );
    }
    if (q.constructorId) items = items.filter((r) => r.entry?.constructor?.id === q.constructorId);
    if (q.status && q.status !== 'all')
      items = items.filter((r) =>
        q.status === 'upcoming' ? r.status === 'scheduled' : r.status === q.status,
      );
    if (q.category) items = items.filter((r) => r.category === q.category);
    if (q.sourceId) items = items.filter((r) => r.sourceId === q.sourceId);
    if (q.fromLap !== undefined) items = items.filter((r) => r.lapNumber >= q.fromLap);
    if (q.toLap !== undefined) items = items.filter((r) => r.lapNumber <= q.toLap);
    if (q.from) items = items.filter((r) => (r.timestamp || r.schedule?.date) >= q.from);
    if (q.to) items = items.filter((r) => (r.timestamp || r.schedule?.date) <= q.to);
    const response = operation.responses['200'].content['application/json'].schema.$ref
      .split('/')
      .at(-1);
    const collection = operation.parameters.some((p) => p.name === 'cursor');
    let data;
    if (collection) {
      const filters = { ...q };
      delete filters.cursor;
      delete filters.snapshotId;
      const identity = hash([op, p, filters]);
      if (cursor && cursor.identity !== identity)
        throw invalid('Cursor does not match filters or route.');
      const offset = cursor?.offset || 0;
      const limit = q.limit || 50;
      const more = offset + limit < items.length;
      data = {
        items: items.slice(offset, offset + limit),
        page: {
          nextCursor: more
            ? Buffer.from(
                JSON.stringify({ snapshot: snapshot.id, identity, offset: offset + limit }),
              ).toString('base64url')
            : null,
          hasMore: more,
          total: set.coverage === 'unavailable' ? null : items.length,
        },
      };
      if (['getTelemetry', 'getLocation'].includes(op))
        data.series = {
          resolution: q.resolution || 'raw',
          aggregation: 'none',
          coverage: set.coverage,
        };
    } else {
      const { contract } = await import('../schemas/contract.js');
      const dataSchema = contract.components.schemas[response].properties.data;
      data = { [Object.keys(dataSchema.properties)[0]]: items[0] || null };
    }
    return {
      body: { data, meta: meta(set, snapshot) },
      responseSchema: response,
      etag: `"${hash([snapshot.id, op, p, q, meta(set, snapshot).freshness])}"`,
    };
  }
}
