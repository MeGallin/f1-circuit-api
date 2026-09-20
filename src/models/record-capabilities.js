const scopeDefinitions = Object.freeze([
  { scope: 'driver', label: 'Driver' },
  { scope: 'constructor', label: 'Constructor' },
  { scope: 'circuit', label: 'Circuit' },
  { scope: 'season', label: 'Season' },
]);

// Keep this catalogue backend-owned. A metric is listed under a scope only
// after its Records reader, qualification rules and evidence contract exist.
// The current Records service has no qualified aggregate for any scope.
const metricDefinitions = Object.freeze([
  { key: 'starts', label: 'Starts', scopes: [] },
  { key: 'wins', label: 'Wins', scopes: [] },
  { key: 'podiums', label: 'Podiums', scopes: [] },
  { key: 'poles', label: 'Pole positions', scopes: [] },
  { key: 'fastest-laps', label: 'Fastest laps', scopes: [] },
  { key: 'points', label: 'Points', scopes: [] },
]);

const unavailableMessage = (label) =>
  `No published Records metrics are available for ${label} yet.`;

export function recordCapabilities() {
  return scopeDefinitions.map(({ scope, label }) => {
    const metrics = metricDefinitions
      .filter((metric) => metric.scopes.includes(scope))
      .map(({ key, label: metricLabel }) => ({ key, label: metricLabel }));
    return {
      scope,
      label,
      metrics,
      reasonCode: metrics.length ? null : 'HISTORICAL_METRIC_NOT_QUALIFIED',
      message: metrics.length ? null : unavailableMessage(label),
    };
  });
}

export function recordMetricCapability(scope, metric) {
  const definition = metricDefinitions.find((item) => item.key === metric);
  return definition?.scopes.includes(scope) ? definition : null;
}

export function recordMetricLabel(metric) {
  return metricDefinitions.find((item) => item.key === metric)?.label || metric;
}
