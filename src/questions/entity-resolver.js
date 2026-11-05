import { normalizeQuestion as normalize } from './period.js';

const contains = (text, name) => name && ` ${normalize(text)} `.includes(` ${normalize(name)} `);
export function matchingProfiles(profiles, kind, text) {
  const ranked = profiles
    .filter((profile) => profile.kind === kind)
    .map((profile) => {
      const name = profile.entity?.displayName || '';
      const aliases = [
        name,
        (profile.entity?.id || profile.id || '').split(':').at(-1),
        ...(profile.aliases || []),
        ...(kind === 'driver' &&
        !/^(one|two|three|four|five|six|seven|eight|nine|ten)$/i.test(name.split(' ').at(-1))
          ? [name.split(' ').at(-1)]
          : []),
      ].filter((alias) => typeof alias === 'string' && normalize(alias).length > 1);
      const matches = aliases.filter((alias) => contains(text, alias));
      return {
        profile,
        rank: matches.length
          ? Math.max(...matches.map((alias) => normalize(alias).split(' ').length))
          : 0,
      };
    })
    .filter((entry) => entry.rank > 0);
  const highest = Math.max(0, ...ranked.map((entry) => entry.rank));
  return ranked.filter((entry) => entry.rank === highest).map((entry) => entry.profile);
}

export async function resolveEntity({
  profiles,
  kind,
  name,
  selectedId,
  period,
  helpers,
  repository,
  publicationId,
}) {
  const named = name ? matchingProfiles(profiles, kind, name) : [];
  if (selectedId) {
    const selected = profiles.find((profile) => profile.kind === kind && profile.id === selectedId);
    if (!selected)
      return { candidates: [], reason: `The selected ${kind} is not published in this snapshot.` };
    if (named.length && !named.some((profile) => profile.id === selectedId))
      return {
        candidates: named,
        conflict: true,
        reason: `The named ${kind} conflicts with the optional selection.`,
      };
    return { profile: selected };
  }
  if (named.length === 1) return { profile: named[0] };
  if (name && repository?.resolve) {
    const id = await repository.resolve(normalize(name), publicationId);
    const profile = profiles.find((entry) => entry.kind === kind && entry.id === id);
    if (profile) return { profile };
  }
  if (named.length > 1 && kind === 'driver' && period.fromYear !== null) {
    const keys = await helpers.keys('results:');
    const participating = new Set();
    for (const key of keys) {
      const set = await helpers.get(key);
      for (const row of set?.items || [])
        if (row.sessionId?.endsWith(':race'))
          for (const driver of row.entry?.drivers || []) participating.add(driver.id);
    }
    const active = named.filter((profile) => participating.has(profile.id));
    if (active.length === 1) return { profile: active[0] };
  }
  return {
    candidates: named,
    reason:
      named.length > 1 ? `Which ${kind} do you mean?` : `Which published ${kind} do you mean?`,
  };
}
