# Natural-language question coverage

This document is the acceptance matrix for `POST /api/v1/questions`. It is deliberately stricter than a keyword search: every answered question must resolve to a published archive record, return structured values and expose evidence IDs. The model may classify wording, but it never supplies a fact, query, identifier or answer.

## User question families

| Family              | Example questions                                          | Required archive data                 | Policy                                                                                            |
| ------------------- | ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Event winner        | “Who won the 2024 British Grand Prix?”                     | Event detail and race result          | Answer deterministically; distinguish an unknown event from an unpublished winner                 |
| Podium              | “Who finished on the podium at Silverstone?”               | Race results                          | Return positions 1–3 in order; do not infer a podium from standings                               |
| Fastest lap         | “Who set the fastest lap in Monaco?”                       | Race result fastest-lap rank          | Return driver, lap and time when supplied; report unavailable when the source did not publish it  |
| Pole position       | “Who was on pole in Spain?”                                | Qualifying position 1                 | Resolve the qualifying session, not the race grid alone                                           |
| Pit stops           | “Who made the most pit stops at Spa?”                      | Pit-stop rows plus entrant mapping    | Aggregate by driver; return zero only when a complete empty dataset is published                  |
| Pit-stop speed      | “What was the fastest pit stop?”                           | Stationary or lane duration           | State which duration was measured; never substitute one for the other silently                    |
| Driver wins         | “How many races has Oscar Piastri won?”                    | Race results                          | Count unique completed race events where position is 1                                            |
| Driver win history  | “When was Oscar’s first/last win?”                         | Race results and event schedules      | Sort by published event date; include the event and date                                          |
| Driver career stats | “How many podiums, poles or fastest laps does Oscar have?” | Race and qualifying results           | Use explicit metric definitions; keep retirements separate from disqualifications and non-starts  |
| Driver comparisons  | “Oscar wins compared with Lando?”                          | Same metric for both drivers          | Return both counts and identify the comparison direction                                          |
| Constructor history | “How many races did Hamilton start for Ferrari?”           | Race results and constructor identity | Count unique race events, with optional year range                                                |
| Season champion     | “Who won the 2024 championship?”                           | Final published standings             | Require a final/complete standing snapshot; do not treat a current leader as champion             |
| Season progression  | “Who led after round 10?”                                  | Round standings                       | Use the exact round snapshot and preserve ties/unknown ranks                                      |
| Race result         | “Where did Norris finish in Canada?”                       | Race classification                   | Distinguish classified position, retirement, disqualification and did-not-start                   |
| Qualifying result   | “Where did Verstappen qualify?”                            | Qualifying rows                       | Do not answer from the race grid when qualifying data is absent                                   |
| Archive coverage    | “Do you have the 2005 pit stops?”                          | Dataset coverage metadata             | Explain partial, unavailable and not-imported separately                                          |
| Source/provenance   | “Where did this answer come from?”                         | Evidence and source observations      | Show provider, retrieval/checksum and conflict state where available                              |
| Session weather     | “Was it raining at Silverstone?”                           | Published OpenF1 weather observations | Return observation-backed rainfall and temperature summaries; never infer conditions from results |
| Tyre strategy       | “What tyres did Norris use in the race?”                   | Published stint rows                  | Return compounds, stints and lap totals only where stint fields are present                       |
| Race control        | “How many safety cars were there?”                         | Published race-control messages       | Count matching published messages and show a small evidence-backed highlight list                 |
| Overtakes           | “Who made the most overtakes?”                             | Published OpenF1 overtake rows        | Aggregate linked passing entrants, disclose source coverage and preserve ties                     |

## Edge-case rules

1. **Unknown person:** ask which driver/constructor when a surname or alias matches more than one published profile.
2. **Unknown event:** ask which Grand Prix when the name maps to zero or multiple events; do not choose the nearest match.
3. **Current season:** say that future rounds have no result yet; never turn a missing future result into a zero.
4. **Partial coverage:** qualify lifetime-looking counts when the archive is partial. A published count is not proof that an unimported season contained no result.
5. **Empty versus missing:** an empty, verified dataset can answer zero; an absent or failed dataset must return `unavailable` with a reason code.
6. **DNF terminology:** “retired”, “disqualified”, “did not start” and “did not qualify” are separate stored states. Do not collapse them into DNF without saying which states were counted.
7. **Ties:** preserve tied positions and tied metrics. Never break a tie by array order.
8. **Sprint weekends:** race, sprint, qualifying and sprint qualifying are different sessions. A “race win” excludes sprint wins unless the question says sprint.
9. **Multiple drivers in one entry:** count the published entry identity once per event, not once per timing row.
10. **Missing fields:** return the fact with `Not supplied` only for that field; do not discard the whole answer or invent a replacement.
11. **Date precision:** preserve date-only schedules and avoid presenting an assumed local time as exact.
12. **Source disagreement:** return the reconciled value and evidence; expose a conflict state rather than silently averaging providers.
13. **Question scope:** years and periods belong to the question. An Explore query must not inherit the currently selected UI season unless the user says so.
14. **Compound questions:** answer every requested clause or state exactly which clause is unavailable. Never answer only the first recognizable phrase.
15. **Comparisons:** calculate both sides with the same scope, metric and coverage boundary; do not compare a current snapshot with a career total.
16. **Scope:** distinguish an event question from a circuit, season or career question. “Silverstone” is a circuit scope; it must not be forced into one Grand Prix.
17. **Championship status:** “Was [driver] ever a world champion?” reads only final published driver standings and answers from rows ranked first; race wins are not used as a proxy for a title.
17. **Relative periods:** convert “this year” and “last year” to explicit years before querying. Do not use the selected UI season as an implicit answer scope.
18. **Circuit history:** “last N races at [circuit]” resolves the circuit, selects the most recent published race result sets, and returns the winners in descending date order. It must not ask the user to choose a Grand Prix.
19. **Country history:** “last N races in [country]” resolves all published circuits whose canonical profile country matches, then selects the most recent published race result sets across those circuits.

## Implementation gates

- Deterministic handlers are preferred for known metrics and event facts.
- The optional interpreter may map unresolved wording to a closed intent enum only.
- Each new intent requires a fixture test for an answer, an unavailable dataset and an ambiguous identity where applicable.
- The client must render the natural-language answer, structured values and evidence without generating factual text.
- Unsupported questions must name the missing capability rather than falling through to a misleading generic record search.

## Deliberate limits

Weather, tyre stints, race control and overtakes now have deterministic session-metric handlers, but they are only answerable where their normalized datasets are published. OpenF1 documents overtakes as potentially incomplete, so answers say “published” and never claim an exhaustive count without coverage evidence. Raw car telemetry, radio and historical scoring remain deliberately unavailable until a bounded summary model and coverage checks are implemented; retaining a provider payload alone is not enough to expose a trustworthy answer.
