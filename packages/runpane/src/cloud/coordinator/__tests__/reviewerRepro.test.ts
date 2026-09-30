// w2-reviewer repro for P1-1: a peer's wake of an AWAKE host resets idle-stop's grace forever.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryAlertSink } from '../alerts';
import { RunawayGuard, SandboxActivity } from '../guards';
import { IdleStopper } from '../idleStop';
import { WakeService } from '../wake';
import { entry, FakeClock, FakeDirectory, FakeProbe, FakeProvider, sandbox } from './fakes';

describe('reviewer repro P1-1', () => {
  it('peer wakes of an awake host every 9 minutes keep idle-stop from ever stopping it', async () => {
    const clock = new FakeClock();
    const provider = new FakeProvider([sandbox('bx_b', 'running')]);
    const probe = new FakeProbe();
    const directory = FakeDirectory.of([entry('sB', 'bx_b')]);
    const activity = new SandboxActivity(clock);
    const alerts = new MemoryAlertSink();
    const guard = new RunawayGuard(clock, { maxLiveSandboxes: 25, maxResumesPerSandboxPerHour: 6, maxResumesPerHour: 60 });
    const wake = new WakeService({ directory, provider, probe, activity, guard, alerts, clock }, {
      managedNamePrefix: 'rp-', selfSandboxId: null, ignoreSandboxIds: [], pinnedVersion: null, pinnedDebUrl: null,
      pinnedDebSha256: null, defaultTimeoutMs: 90_000, maxTimeoutMs: 300_000, daemonDownGraceMs: 60_000,
      pollIntervalMs: 1000, upgradeTimeoutMs: 60_000,
    });
    // Coordinator defaults: idle check every 300 s, 2 consecutive safe answers, 600 s wake grace.
    const idle = new IdleStopper({ directory, provider, probe, activity, alerts }, { requiredConsecutiveSafe: 2, wakeGraceMs: 600_000, dryRun: false });
    const decisions: string[] = [];
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      if (minute % 9 === 0) {
        const answer = await wake.wake('sB', { wait: false });
        assert.equal(answer.ok && answer.status, 'awake');
      }
      if (minute % 5 === 0) decisions.push((await idle.runOnce()).results[0].decision);
      clock.time += 60_000;
    }
    console.log(`repro P1-1: ${decisions.length} idle checks over 24 h, decisions=${[...new Set(decisions)].join(',')}, mutations=${JSON.stringify(provider.mutations())}`);
    // Every safe-to-stop answer was "safe", yet the host was never stopped.
    assert.deepEqual(provider.mutations(), []);
  });
});
