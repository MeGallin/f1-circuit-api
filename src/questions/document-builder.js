import { hash } from '../models/dataset.js';

const displayName = (item) =>
  item?.entity?.displayName || item?.displayName || item?.name || item?.event?.name || item?.id;

const driverNames = (item) =>
  (item?.entry?.drivers || item?.drivers || [])
    .map((driver) => driver.displayName || driver.name)
    .filter(Boolean);

const constructorName = (item) =>
  item?.entry?.constructor?.displayName ||
  item?.constructor?.displayName ||
  item?.constructor?.name ||
  null;

const circuitName = (item) =>
  item?.circuit?.displayName || item?.circuit?.name || item?.event?.circuit?.displayName || null;

function summary(key, item) {
  const values = [
    key,
    item?.kind,
    displayName(item),
    item?.id,
    item?.year,
    item?.round,
    item?.status,
    item?.position,
    item?.sessionId,
    item?.event?.name,
    item?.event?.year,
    circuitName(item),
    item?.country,
    constructorName(item),
    ...driverNames(item),
  ];
  return values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .join(' | ');
}

function metadata(key, item, evidenceId) {
  const drivers = item?.entry?.drivers || item?.drivers || [];
  const eventId =
    item?.event?.id || item?.eventId || item?.sessionId?.match(/^session:(.+):[^:]+$/)?.[1] || null;
  return {
    recordId: item?.id || null,
    kind: item?.kind || null,
    season: item?.year || item?.event?.year || null,
    eventId,
    driverId: drivers[0]?.id || item?.driver?.id || null,
    driverIds: drivers.map((driver) => driver.id).filter(Boolean),
    constructorId: item?.entry?.constructor?.id || item?.constructor?.id || null,
    circuitId: item?.circuit?.id || item?.event?.circuit?.id || null,
    sessionId: item?.sessionId || null,
    position: item?.position ?? null,
    evidenceIds: [evidenceId, item?.evidenceId].filter(Boolean),
  };
}

function entityType(key, item) {
  if (key.startsWith('profile:')) return item?.kind || 'profile';
  if (key.startsWith('events:') || key.startsWith('event:')) return 'event';
  if (key.startsWith('results:')) return 'race-result';
  if (key.startsWith('qualifying:')) return 'qualifying-result';
  if (key.startsWith('standings:')) return 'standing';
  return key.split(':')[0] || 'record';
}

export function buildQuestionDocuments({ publicationId, sets }) {
  const documents = [];
  for (const set of sets) {
    // Raw result/session rows remain relational query data. Embedding tens of
    // thousands of facts would add cost without improving entity resolution;
    // the exact executors query those rows directly. Index a compact dataset
    // document so the planner can still understand what is published.
    const isSemanticRecordSet =
      set.key.startsWith('profile:') ||
      set.key.startsWith('events:') ||
      set.key.startsWith('event:');
    if (!isSemanticRecordSet) {
      const sampleFields = Object.keys(set.items?.[0] || {})
        .slice(0, 24)
        .join(', ');
      const content = [
        `dataset ${set.key}`,
        `schema ${set.schema || 'unknown'}`,
        `coverage ${set.coverage || 'unknown'}`,
        `records ${set.items?.length || 0}`,
        sampleFields ? `fields ${sampleFields}` : null,
        ...(set.warnings || []).map((warning) => warning.message || warning.code),
      ]
        .filter(Boolean)
        .join(' | ');
      const documentId = hash([set.key, 'summary']).slice(0, 40);
      documents.push({
        document_id: documentId,
        entity_type: 'dataset',
        entity_id: set.key,
        dataset_key: set.key,
        title: `Dataset ${set.key}`,
        content,
        metadata: {
          datasetKey: set.key,
          recordCount: set.items?.length || 0,
          coverage: set.coverage || 'unknown',
          verification: set.verification || 'unknown',
          evidenceIds: [set.evidenceId].filter(Boolean),
        },
        content_hash: hash([set.key, set.items?.length || 0, set.coverage, sampleFields]),
        publicationId,
      });
      continue;
    }
    for (const item of set?.items || []) {
      const recordId = item.id || hash(item).slice(0, 24);
      const documentId = hash([set.key, recordId]).slice(0, 40);
      const content = summary(set.key, item);
      documents.push({
        document_id: documentId,
        entity_type: entityType(set.key, item),
        entity_id: item.id || recordId,
        dataset_key: set.key,
        title: String(displayName(item) || recordId),
        content,
        metadata: metadata(set.key, item, set.evidenceId),
        content_hash: hash([set.key, item]),
        publicationId,
      });
    }
  }
  return documents;
}
