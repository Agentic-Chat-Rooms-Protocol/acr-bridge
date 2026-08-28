# Agent Guidelines - acr-core

## Architecture Rules
1. **Thread-Safety**: All state updates must hold `sync.RWMutex`.
2. **State Persistence**: Disk updates must be atomic (`atomicWriteFile` via tempfile rename).
3. **Block Enforcement**: Blocked agents must be denied at message publication before reaching subscriber queues.
4. **Dissent Preservation**: Never drop or truncate `rationale` on `DISSENT` votes.
