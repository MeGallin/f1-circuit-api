# Standings podium projection — 13 October 2026

`getStandings` calculates driver and constructor podiums from stored published
final race classifications, at the selected immutable publication. The standing
rows own the season and cutoff round; explicit round/snapshot selection and every
page use that same scope. No provider calls, imports or database writes occur.
Stored normalization still leaves podiums null: this is a read projection, not a
rewrite of source assertions. Other standing consumers retain their existing fields.

## Counting and evidence

Only eligible published race positions 1, 2 and 3 count. Sprint, qualifying,
scheduled sessions and later rounds are excluded. Constructor credit belongs to
the result entry's historical constructor, once per podium car; two cars give two
credits. Every distinct driver explicitly listed on a shared car receives one
credit for that car. A driver repeated across entries, duplicated driver IDs within
an entry, duplicate entries/results/positions and conflicting context cannot
establish a count. Shared-car semantics describe entry participation, not audited
historical championship credit allocation. Analytics reuses the same unchanged
rank eligibility helper; this projection additionally requires a known finished
or retired podium outcome and rejects explicit unclassified podium assertions.

Each returned standing row has `podiumCoverage`: `coverage`, `throughRound`,
`expectedRaces`, `verifiedRaces`, `observedRaces`, `snapshotId` and result
`evidenceIds`. Legacy/unprojected standing records may omit it or have null.

- `complete`: every round through the cutoff is accounted for in the calendar
  (explicit cancellations excluded), and every applicable race has exactly one
  completed race session and all three valid, unique podium positions. Zero then
  proves absence within these published results. Generic source coverage remains
  unchanged: partial lower classifications do not invalidate complete podium slots.
- `partial`: valid observed podium positions exist, but some round, race or slot
  cannot be established. Counts are observed only, including observed zero; the
  client explicitly labels them and states race coverage. A missing calendar round
  remains in the expected denominator rather than disappearing from scope.
- `unavailable`: no usable podium evidence or ambiguous standing/calendar scope;
  podiums are null, never an invented zero.

Deliberate conservative tradeoff: a malformed/conflicting row anywhere in a race
collection excludes that race, because it could duplicate a counted car or driver.
A valid race with only one/two supplied podium slots contributes those observed
slots but cannot establish completeness. An unambiguously later calendar round
cannot invalidate an earlier selection; unknown round context remains unavailable.
This proves stored podium-slot completeness, not independent real-world source accuracy.

## Batching and cache validators

Three repository `getMany` stages load calendar, completed race session indexes
and full stored race result collections. Production `getMany` already uses two SQL
reads per batch; there is no request/query per standing row. Bounds: 64 rounds,
256 calendar/result records per dataset, 32 sessions per event, eight explicitly
listed shared drivers per car. Oversized/ambiguous collections are unavailable.
Projection precedes pagination. No browser result requests are added.

Standings ETags include the derived response data and stable metadata, excluding
`generatedAt`. They invalidate old null-podium responses and coverage-only changes;
equivalent requests retain conditional 304 support. Other routes retain their
existing validator identity. `scripts/update-standing-podium-contract.js` applies
only keyed podium schema changes to both contracts and updates the API checksum;
two consecutive runs preserved all three generated-file hashes.

## Verification boundary

Fail-before evidence: 19 initial API cases failed on missing counts/coverage;
one later-round corruption case and two separate conditional-GET cases then failed
before their fixes. Final focused projection run: 22 passed. The first ETag trial
used query keys in a different serialization order and passed; it is not claimed
as red evidence. The corrected legacy-validator fixture reproduced stale HTTP304.
Client initially failed four coverage display cases, then passed all nine standings
tests. Final client contract/standing/entity/race/season selection: 40 tests in
four files passed; lint and production build passed. Prebuild validated 49
constructor assets and 30 country flags. Existing Vite large-chunk warning remains.
Full client suite was not rerun. Final API `npm run check` passed232 tests,
lint/format, OpenAPI/checksum and Newman117 requests/197 assertions with no failures.
Earlier231-test gate predates the final stable-metadata ETag case. Documentation
annotations after the final gates did not trigger additional application tests.

Local GET corroboration used publication
`1cf93890-260a-43ad-9cab-9d3170ff43b3`: latest 2026 R17 constructor totals
Mercedes22/Ferrari11/RedBull11/McLaren7 and unpinned limit20 driver totals
Antonelli14/Russell8/Hamilton6/Verstappen9/Leclerc5/Norris5/Piastri2/Hadjar2 matched
the parent's independently retrieved raw-result oracle. Parent compared all23
driver and all11 constructor standings against all17 full final-race collections:
51 podium cars, three validated positions per race, all sets labelled partial.
Parent historical2000R1 oracle and browser gave Schumacher1/Barrichello1/Ralf1,
Ferrari2/Williams1, others0. These are stored publication observations, not model facts.

Parent browser proof covered latest drivers/constructors, 2026R1, 2000R1, source
coverage copy, and390px rows (client/scroll376). Refresh replaced the stale latest
null-podium cache after the ETag fix. External screenshots are
`site-wide/standing-podiums-2026-10-13-{constructors,drivers,mobile,historical}.jpg`.
Parent restored normal viewport/2026 Drivers Latest/System. Cody did not operate
the browser. No production deployment, commit, push, import or live write occurred.

Earlier parent limit3 GET500 was not independently reproduced or assigned a cause;
parent subsequently observed200 at limit50. Current observed GETs are200. Do not
infer a provider/database outage or invalid-limit cause from that historical report.
