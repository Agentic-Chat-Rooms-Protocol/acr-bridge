import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OutputBudget } from '../src/output_budget.js';

describe('acr-bridge/core: OutputBudget Memory Backpressure Guard', () => {
  it('should initialize with default 32 MB ceiling and 30s stall timeout', () => {
    const budget = new OutputBudget();
    assert.equal(budget.maxBufferBytes, 33554432); // 32 * 1024 * 1024
    assert.equal(budget.stallTimeoutMs, 30000);
    assert.equal(budget.resumeThresholdBytes, 16777216); // 50%
    assert.equal(budget.state, 'flowing');
    assert.equal(budget.bufferedBytes, 0);
    assert.equal(budget.isPaused, false);
    assert.equal(budget.isDisconnected, false);
  });

  it('should accept writes and track buffered bytes when flowing', () => {
    const budget = new OutputBudget();
    const ok1 = budget.write('Hello, ACR Pod!');
    assert.equal(ok1, true);
    assert.equal(budget.bufferedBytes, 15);

    const ok2 = budget.write(Buffer.alloc(1000));
    assert.equal(ok2, true);
    assert.equal(budget.bufferedBytes, 1015);
  });

  it('should trigger backpressure and pause when 32 MB ceiling is exceeded', () => {
    let pausedTriggered = false;
    let pausedBytes = 0;

    const budget = new OutputBudget({
      maxBufferBytes: 1000,
      resumeWatermarkRatio: 0.5,
      onPause: (bytes) => {
        pausedTriggered = true;
        pausedBytes = bytes;
      },
    });

    // Write 800 bytes - still flowing
    assert.equal(budget.write(800), true);
    assert.equal(budget.isPaused, false);
    assert.equal(pausedTriggered, false);

    // Write 300 bytes - projects to 1100, should hit 1000 limit and pause
    const ok = budget.write(300);
    assert.equal(ok, false);
    assert.equal(budget.isPaused, true);
    assert.equal(budget.state, 'paused');
    assert.equal(pausedTriggered, true);
    assert.equal(pausedBytes, 1000);
  });

  it('should resume flowing only when drained below the resume watermark (50%)', () => {
    let resumedTriggered = false;
    const budget = new OutputBudget({
      maxBufferBytes: 1000,
      resumeWatermarkRatio: 0.5,
      onResume: () => {
        resumedTriggered = true;
      },
    });

    budget.write(1000);
    assert.equal(budget.isPaused, true);

    // Drain 200 bytes (buffered is now 800 > 500 watermark) - should remain paused
    budget.drain(200);
    assert.equal(budget.isPaused, true);
    assert.equal(resumedTriggered, false);

    // Drain 350 bytes (buffered is now 450 <= 500 watermark) - should resume
    budget.drain(350);
    assert.equal(budget.isPaused, false);
    assert.equal(budget.state, 'flowing');
    assert.equal(resumedTriggered, true);
    assert.equal(budget.bufferedBytes, 450);
  });

  it('should disconnect stalled sessions after 30 seconds of sustained backpressure', () => {
    let disconnectedReason: string | null = null;
    const budget = new OutputBudget({
      maxBufferBytes: 100,
      stallTimeoutMs: 30000,
      onDisconnect: (reason) => {
        disconnectedReason = reason;
      },
    });

    const t0 = 1000000;
    budget.write(150, t0);
    assert.equal(budget.isPaused, true);

    // At 10s elapsed (under 30s) -> checkStall should return false
    assert.equal(budget.checkStall(t0 + 10000), false);
    assert.equal(budget.isDisconnected, false);

    // At 29.9s elapsed -> still false
    assert.equal(budget.checkStall(t0 + 29900), false);
    assert.equal(budget.isDisconnected, false);

    // At 30.1s elapsed -> should trigger stall disconnect
    assert.equal(budget.checkStall(t0 + 30100), true);
    assert.equal(budget.isDisconnected, true);
    assert.equal(budget.state, 'disconnected');
    assert.match(disconnectedReason!, /stall_timeout/);
  });

  it('should reset stall timeout countdown when bytes are actively drained without dropping below resume watermark', () => {
    const budget = new OutputBudget({
      maxBufferBytes: 1000,
      stallTimeoutMs: 30000,
      resumeWatermarkRatio: 0.5, // 500 bytes resume threshold
    });

    const t0 = 1000000;
    budget.write(1000, t0);
    assert.equal(budget.isPaused, true);

    // At 25s elapsed, drain 100 bytes (buffered is 900 > 500 watermark, still paused)
    budget.drain(100, t0 + 25000);
    assert.equal(budget.isPaused, true);

    // At 35s elapsed from start (10s elapsed since last drain) -> should NOT disconnect!
    assert.equal(budget.checkStall(t0 + 35000), false);
    assert.equal(budget.isDisconnected, false);

    // At 55.1s elapsed (30.1s after last drain) -> should now disconnect
    assert.equal(budget.checkStall(t0 + 55100), true);
    assert.equal(budget.isDisconnected, true);
  });

  it('should reject writes when disconnected', () => {
    const budget = new OutputBudget();
    budget.disconnect('operator_veto');

    assert.throws(
      () => budget.write('test'),
      /Cannot write to disconnected OutputBudget session/
    );
  });

  it('should provide accurate HUD snapshot telemetry', () => {
    const budget = new OutputBudget({
      maxBufferBytes: 2000,
      stallTimeoutMs: 30000,
    });

    const t0 = 500000;
    budget.write(2000, t0);

    const snap = budget.getSnapshot(t0 + 10000);
    assert.equal(snap.state, 'paused');
    assert.equal(snap.bufferedBytes, 2000);
    assert.equal(snap.maxBufferBytes, 2000);
    assert.equal(snap.utilizationPct, 100.0);
    assert.equal(snap.isPaused, true);
    assert.equal(snap.isDisconnected, false);
    assert.equal(snap.stallTimeRemainingMs, 20000);
  });
});
