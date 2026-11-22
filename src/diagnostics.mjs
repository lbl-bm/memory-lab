// queryObjects creates strong remote handles. Every handle is scoped to one group
// and released even if the query or the count fails, before the next GC/snapshot.
export async function countObjectsByPrototype(cdp, expression) {
  const group = 'memory-lab-short-lived-object-census';
  try {
    const prototype = await cdp.send('Runtime.evaluate', { expression, objectGroup: group, returnByValue: false });
    if (prototype.exceptionDetails || !prototype.result.objectId) throw new Error('Diagnostic prototype is unavailable');
    const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
    const count = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function() { return this.length; }', returnByValue: true });
    if (count.exceptionDetails || !Number.isInteger(count.result.value)) throw new Error('Object census failed');
    return { liveInstances: count.result.value, method: 'CDP Runtime.queryObjects; remote object group released before sampling' };
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }); }
}
