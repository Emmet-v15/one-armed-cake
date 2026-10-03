# Data

Raw per-trial results from `tools/exp.py`, one JSON object per line. `tools/analyze.py` turns them into the paper's tables and figures.

| file | contents |
|---|---|
| `results-upload.jsonl` | 20 trials: {4, 16} uploads × marking {none, EF} × 5 repetitions |
| `results-download.jsonl` | 18 trials: 6 download conditions × 3 repetitions |
| `results-download-INVALID-python-client.jsonl` | **invalid**, kept for transparency: 18 download trials whose load generator was throttled on the client (see `docs/measurement.md`, pitfalls). Do not use. |

Line: VDSL2 (PTM), ~5.9 Mbit/s down / 2.0 Mbit/s up sync; upload capped at 1800 kbit/s in all trials. Measured 2026-09-24/25 (UTC+1).

## Record format

```json
{
  "cond": "up16-ef",            // condition name (see below)
  "rep": 0,                     // repetition index; conditions interleave within a rep
  "ts": 1790290000.0,           // unix time the trial finished
  "direction": "up",            // "up" or "down"
  "streams": 16,                // number of bulk TCP streams
  "idle":   {"n": 100, "lost": 0, "med": 15.2, "p95": 16.3, "p99": 20.0, "max": 20.0},
  "start":  { ... },            // first 1.5 s of load
  "steady": { ... },            // remaining 6.5 s of load
  "goodput_mbps": 2.80          // download only: curl bytes / 8 s, slow start included
}
```

Latencies are probe round-trip times in milliseconds. `n` is probes sent in the window; `lost` is probes with no echo by the end of the trial.

Upload records also carry `wire_up_mbps`, an upload-rate field written by the version of `exp.py` used for these runs. The current `exp.py` does not write it and `analyze.py` does not read it; no table or figure depends on it.

## Condition names

- `up{N}-{none|ef}`: N upload streams, game-packet classifier off or on.
- `down-{cap}-rtt{R}-{ef|none}`: download cap in kbit/s (`unlimited` = profile `max`), CAKE `rtt`, classifier on or off; 4 streams.
