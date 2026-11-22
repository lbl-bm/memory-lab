// Keep the CLI event loop alive while a stage is pending, with a finite bound.
export async function withDeadline(pending, ms, label, onLateResolution) {
  let expired = false;
  let timer;
  const source = Promise.resolve(pending);
  source.then(value => { if (expired) Promise.resolve().then(() => onLateResolution?.(value)).catch(() => {}); }, () => {});
  try {
    return await Promise.race([source, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error(label + ' exceeded its ' + ms + 'ms deadline')); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Browser backends can die while an API request remains pending. Surface that
// event as a capture error instead of leaving an unsettled top-level await.
export async function withBrowserStage(browser, action, ms, label) {
  if (!browser.isConnected()) throw new Error('Browser disconnected before ' + label);
  let abandoned = false;
  let listener;
  const disconnected = new Promise((_, reject) => {
    listener = () => reject(new Error('Browser disconnected during ' + label));
    browser.on('disconnected', listener);
  });
  const pending = Promise.resolve().then(action);
  pending.then(value => {
    if (abandoned && typeof value?.close === 'function') Promise.resolve().then(() => value.close()).catch(() => {});
  }, () => {});
  try { return await withDeadline(Promise.race([pending, disconnected]), ms, label); }
  catch (error) { abandoned = true; throw error; }
  finally { browser.off('disconnected', listener); }
}
