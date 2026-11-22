import { runBrowserCaptureCommand } from './browser-sites-command.mjs';

export async function runBrowserResourcesCommand(configPath, options) {
  const { points, ...result } = await runBrowserCaptureCommand(configPath, './browser-resources-worker.mjs', 'browser-resources.json', options);
  const cases = {};
  for (const point of points.filter(value => value.mode === 'instrumented')) {
    const entry = cases[point.case] ??= { activeCounts: [], releasedCounts: [], completedCounts: [], unavailableTargetCounts: [] };
    entry.activeCounts.push(point.observation.resources.filter(resource => resource.state === 'active').length);
    entry.releasedCounts.push(point.observation.resources.filter(resource => resource.state === 'released').length);
    entry.completedCounts.push(point.observation.resources.filter(resource => resource.state === 'completed').length);
    entry.unavailableTargetCounts.push(point.observation.coverage.unavailableActiveTargets ?? 0);
  }
  return { ...result, pointCount: points.length, summary: { caseCount: Object.keys(cases).length, cases } };
}
