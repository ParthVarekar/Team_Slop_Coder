process.env.WEFT_FANOUT_CLIENTS = '1';
process.env.WEFT_FANOUT_RATE = '500';
process.env.WEFT_FANOUT_SECONDS = '20';
process.env.WEFT_FANOUT_CATCHUP_GATE_MS = '100';
await import('./fanout-load.mjs');
