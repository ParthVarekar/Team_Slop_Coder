process.on('message', (message) => {
  if (message?.type !== 'weft:gc') return;
  globalThis.gc();
  process.send?.({ type: 'weft:gc:done', request_id: message.request_id });
});
