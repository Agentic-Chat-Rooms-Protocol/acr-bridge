/**
 * RFC-0016 / Deep Moat: OutputBudget Memory Backpressure Guard
 *
 * Enforces a strict 32 MB per-session output memory ceiling with
 * pause-on-overflow backpressure and forced disconnection after 30 seconds
 * of sustained stall/unconsumed backpressure.
 *
 * Invariant: Zero emoji.
 */

export type BudgetState = 'flowing' | 'paused' | 'disconnected';

export interface OutputBudgetOptions {
  /** Maximum unconsumed buffer in bytes. Default: 33554432 (32 MB) */
  maxBufferBytes?: number;
  /** Stall duration in milliseconds before disconnect. Default: 30000 (30s) */
  stallTimeoutMs?: number;
  /** Low-water mark fraction to resume flowing (0.0 - 1.0). Default: 0.5 (16 MB) */
  resumeWatermarkRatio?: number;
  /** Auto-start background timer for stall monitoring. Default: false (manual/testable tick) */
  autoTimer?: boolean;
  /** Callbacks */
  onPause?: (bufferedBytes: number) => void;
  onResume?: (bufferedBytes: number) => void;
  onDisconnect?: (reason: string, bufferedBytes: number) => void;
}

export interface OutputBudgetSnapshot {
  state: BudgetState;
  bufferedBytes: number;
  maxBufferBytes: number;
  utilizationPct: number;
  isPaused: boolean;
  isDisconnected: boolean;
  stallTimeRemainingMs: number;
  disconnectReason: string | null;
}

export class OutputBudget {
  public static readonly DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024; // 33,554,432 bytes (32 MB)
  public static readonly DEFAULT_STALL_TIMEOUT_MS = 30 * 1000; // 30,000 ms (30s)

  public readonly maxBufferBytes: number;
  public readonly stallTimeoutMs: number;
  public readonly resumeThresholdBytes: number;

  private _bufferedBytes = 0;
  private _state: BudgetState = 'flowing';
  private _lastConsumptionTime: number;
  private _pausedSinceTime: number | null = null;
  private _disconnectReason: string | null = null;
  private _timerHandle: NodeJS.Timeout | null = null;

  private readonly onPause?: (bufferedBytes: number) => void;
  private readonly onResume?: (bufferedBytes: number) => void;
  private readonly onDisconnect?: (reason: string, bufferedBytes: number) => void;

  constructor(options: OutputBudgetOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? OutputBudget.DEFAULT_MAX_BUFFER_BYTES;
    this.stallTimeoutMs = options.stallTimeoutMs ?? OutputBudget.DEFAULT_STALL_TIMEOUT_MS;
    const ratio = Math.max(0.1, Math.min(0.9, options.resumeWatermarkRatio ?? 0.5));
    this.resumeThresholdBytes = Math.floor(this.maxBufferBytes * ratio);

    this.onPause = options.onPause;
    this.onResume = options.onResume;
    this.onDisconnect = options.onDisconnect;

    this._lastConsumptionTime = Date.now();

    if (options.autoTimer) {
      this.startTimer();
    }
  }

  public get state(): BudgetState {
    return this._state;
  }

  public get bufferedBytes(): number {
    return this._bufferedBytes;
  }

  public get isPaused(): boolean {
    return this._state === 'paused';
  }

  public get isDisconnected(): boolean {
    return this._state === 'disconnected';
  }

  public get disconnectReason(): string | null {
    return this._disconnectReason;
  }

  /**
   * Enqueues bytes or chunk into the output queue.
   * Returns true if accepted and stream remains flowing.
   * Returns false if backpressure is reached/paused or buffer is rejected.
   * Throws Error if connection is already disconnected.
   */
  public write(chunk: number | Uint8Array | Buffer | string, nowMs = Date.now()): boolean {
    if (this._state === 'disconnected') {
      throw new Error(`Cannot write to disconnected OutputBudget session: ${this._disconnectReason}`);
    }

    const byteLen = this.resolveByteLength(chunk);
    const projectedBytes = this._bufferedBytes + byteLen;

    if (projectedBytes >= this.maxBufferBytes) {
      // Over ceiling: Cap to maxBufferBytes or reject
      this._bufferedBytes = Math.min(projectedBytes, this.maxBufferBytes);
      if (this._state !== 'paused') {
        this._state = 'paused';
        this._pausedSinceTime = nowMs;
        if (this.onPause) {
          this.onPause(this._bufferedBytes);
        }
      }
      return false; // Backpressure triggered
    }

    this._bufferedBytes = projectedBytes;
    return true; // Flowing normally
  }

  /**
   * Consumes bytes drained from the network socket.
   * Resets stall duration and unpauses if buffer dips below the resume watermark.
   */
  public drain(bytes: number, nowMs = Date.now()): void {
    if (this._state === 'disconnected') {
      return;
    }

    const consumed = Math.max(0, Math.min(bytes, this._bufferedBytes));
    this._bufferedBytes -= consumed;
    this._lastConsumptionTime = nowMs;

    if (this._state === 'paused') {
      if (this._bufferedBytes <= this.resumeThresholdBytes) {
        this._state = 'flowing';
        this._pausedSinceTime = null;
        if (this.onResume) {
          this.onResume(this._bufferedBytes);
        }
      } else if (consumed > 0) {
        // Active progress was made without dropping below watermark: reset stall countdown
        this._pausedSinceTime = nowMs;
      }
    }
  }

  /**
   * Evaluates whether the connection has stalled while under backpressure.
   * Disconnects if paused without progress for >= stallTimeoutMs.
   */
  public checkStall(nowMs = Date.now()): boolean {
    if (this._state === 'disconnected') {
      return true;
    }

    if (this._state === 'paused' && this._pausedSinceTime !== null) {
      const stallDuration = nowMs - this._pausedSinceTime;
      if (stallDuration >= this.stallTimeoutMs) {
        this.disconnect(`stall_timeout: ${Math.round(stallDuration / 1000)}s sustained backpressure without drain`);
        return true;
      }
    }

    return false;
  }

  /**
   * Force disconnect the session with an audit reason.
   */
  public disconnect(reason: string): void {
    if (this._state === 'disconnected') {
      return;
    }

    this._state = 'disconnected';
    this._disconnectReason = reason;
    this.stopTimer();

    if (this.onDisconnect) {
      this.onDisconnect(reason, this._bufferedBytes);
    }
  }

  /**
   * Returns telemetry snapshot for observability HUD.
   */
  public getSnapshot(nowMs = Date.now()): OutputBudgetSnapshot {
    let stallRemaining = this.stallTimeoutMs;
    if (this._state === 'paused' && this._pausedSinceTime !== null) {
      const elapsed = nowMs - this._pausedSinceTime;
      stallRemaining = Math.max(0, this.stallTimeoutMs - elapsed);
    }

    return {
      state: this._state,
      bufferedBytes: this._bufferedBytes,
      maxBufferBytes: this.maxBufferBytes,
      utilizationPct: Number(((this._bufferedBytes / this.maxBufferBytes) * 100).toFixed(2)),
      isPaused: this.isPaused,
      isDisconnected: this.isDisconnected,
      stallTimeRemainingMs: stallRemaining,
      disconnectReason: this._disconnectReason,
    };
  }

  public startTimer(intervalMs = 1000): void {
    if (this._timerHandle) return;
    this._timerHandle = setInterval(() => {
      this.checkStall();
    }, intervalMs);
  }

  public stopTimer(): void {
    if (this._timerHandle) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
  }

  private resolveByteLength(chunk: number | Uint8Array | Buffer | string): number {
    if (typeof chunk === 'number') {
      return Math.max(0, chunk);
    }
    if (typeof chunk === 'string') {
      return Buffer.byteLength(chunk, 'utf8');
    }
    return chunk.byteLength || 0;
  }
}
