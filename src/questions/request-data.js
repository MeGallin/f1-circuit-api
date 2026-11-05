// SQL retains its own statement timeout. This bounds the caller's remaining
// budget without claiming to cancel an already executing PostgreSQL statement.
export async function beforeDeadline(deadline, run) {
  const failure = () =>
    Object.assign(new Error('Question deadline exceeded.'), {
      code: 'QUESTION_DEADLINE_EXCEEDED',
    });
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw failure();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then((value) => {
          if (Date.now() >= deadline) throw failure();
          return value;
        }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure()), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// All cache keys and reads belong to one immutable publication and one request.
export function requestData(repository, snapshot, source, period, deadline) {
  const values = new Map();
  const lists = new Map();
  const proofs = new Map();
  const check = () => {
    if (Date.now() >= deadline) {
      const error = new Error('Question deadline exceeded.');
      error.code = 'QUESTION_DEADLINE_EXCEEDED';
      throw error;
    }
  };
  const get = (key) => {
    check();
    if (!values.has(key))
      values.set(
        key,
        beforeDeadline(deadline, () => source.get(key)),
      );
    return values.get(key);
  };
  const keys = async (prefix) => {
    check();
    if (!lists.has(prefix))
      lists.set(
        prefix,
        (async () => {
          let list = await beforeDeadline(deadline, () => source.keys(prefix));
          if (period.fromYear !== null && /^(results|qualifying|events|standings):/.test(prefix))
            list = list.filter((key) => {
              const match = key.match(/(?:event:|events:|standings:)(\d{4})(?=:|$)/);
              return (
                !match || (Number(match[1]) >= period.fromYear && Number(match[1]) <= period.toYear)
              );
            });
          if (repository.getMany)
            for (let offset = 0; offset < list.length; offset += 256) {
              check();
              const missing = list.slice(offset, offset + 256).filter((key) => !values.has(key));
              if (missing.length) {
                const batch = await beforeDeadline(deadline, () =>
                  repository.getMany(missing, snapshot?.id),
                );
                for (const key of missing) values.set(key, Promise.resolve(batch.get(key) || null));
              }
            }
          return list;
        })(),
      );
    return lists.get(prefix);
  };
  return {
    get,
    keys,
    async calendarProof(year, calendar) {
      check();
      if (!proofs.has(year))
        proofs.set(
          year,
          beforeDeadline(deadline, () =>
            repository.calendarProof
              ? repository.calendarProof(year, calendar, snapshot?.id)
              : Promise.resolve({ complete: false }),
          ),
        );
      return proofs.get(year);
    },
    setPeriod(next) {
      period = next;
      lists.clear();
    },
  };
}
