import { benchmarkProject, loadScenarios } from '../src/benchmark';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Benchmark Tests', () => {
  it('BENCHMARK_SCENARIOS module keys are strings', () => {
    const { BENCHMARK_SCENARIOS } = require('../src/benchmark');
    BENCHMARK_SCENARIOS.forEach((scenario: { moduleKey: string }) => {
      expect(typeof scenario.moduleKey).toBe('string');
      expect(scenario.moduleKey.length).toBeGreaterThan(0);
    });
  });

  it('Scenario path resolution is deterministic and scoped', async () => {
    const fixtureRoot = path.join(__dirname, 'fixtures');
    const moduleKey = 'src';

    const benchmarkResult = await benchmarkProject(fixtureRoot, moduleKey, 'Test Project', 'authentication flow');

    const expectedPath = path.join(fixtureRoot, 'src');
    expect(benchmarkResult.projectRoot).toBe(expectedPath);

    expect(benchmarkResult.top1KeywordCoverage).toBeGreaterThanOrEqual(0);
    expect(benchmarkResult.top1KeywordCoverage).toBeLessThanOrEqual(1);
    expect(benchmarkResult.avgTopKKeywordCoverage).toBeGreaterThanOrEqual(0);
    expect(benchmarkResult.avgTopKKeywordCoverage).toBeLessThanOrEqual(1);
    expect(benchmarkResult.pathIntentMatchRate).toBeGreaterThanOrEqual(0);
    expect(benchmarkResult.pathIntentMatchRate).toBeLessThanOrEqual(1);
    expect(benchmarkResult.directoryDiversity).toBeGreaterThanOrEqual(0);
    expect(benchmarkResult.directoryDiversity).toBeLessThanOrEqual(1);
  });
});

describe('loadScenarios', () => {
  function write(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-scen-'));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, content);
    return file;
  }

  it('reads scenarios and defaults the limit to 10', () => {
    const file = write('[{"moduleKey":"packages/core","query":"di"},{"moduleKey":"src","query":"q","limit":3}]');
    expect(loadScenarios(file)).toEqual([
      { moduleKey: 'packages/core', query: 'di', limit: 10 },
      { moduleKey: 'src', query: 'q', limit: 3 },
    ]);
  });

  it('rejects bad input with a message naming the scenario', () => {
    expect(() => loadScenarios(write('not json'))).toThrow(/Cannot read scenarios file/);
    expect(() => loadScenarios(write('[]'))).toThrow(/non-empty JSON array/);
    expect(() => loadScenarios(write('{}'))).toThrow(/non-empty JSON array/);
    expect(() => loadScenarios(write('[{"moduleKey":"","query":"q"}]'))).toThrow(/Scenario 1.*moduleKey/);
    expect(() => loadScenarios(write('[{"moduleKey":"a"}]'))).toThrow(/Scenario 1.*query/);
    expect(() => loadScenarios(write('[{"moduleKey":"a","query":"q"},{"moduleKey":"b","query":"q","limit":0}]'))).toThrow(/Scenario 2.*limit/);
    expect(() => loadScenarios(write('[{"moduleKey":"a","query":"q","limit":1.5}]'))).toThrow(/Scenario 1.*limit/);
  });

  it('reports a missing file', () => {
    expect(() => loadScenarios(path.join(os.tmpdir(), 'skannr-does-not-exist.json'))).toThrow(/Cannot read scenarios file/);
  });
});
