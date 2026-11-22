import { createHash } from 'node:crypto';
export const observationPolicy = Object.freeze({ maxMethods: 8, maxMembers: 128, maxEventsPerWindow: 128, scope: 'Opt-in own configurable synchronous methods and a tagged-resource Array data property only' });
const digest = text => createHash('sha256').update(text).digest('hex');
const valueOf = (object, property) => {
  const d = Object.getOwnPropertyDescriptor(object, property);
  if (!d || !Object.hasOwn(d, 'value')) throw Error('missing-or-accessor-property');
  return d.value;
};
export function readTaggedArrayView(owner, property, ownerToken) {
  try {
    const array = valueOf(owner, property);
    if (!Array.isArray(array) || array.length > observationPolicy.maxMembers) throw Error('unsupported-or-oversized-array');
    const tokens = [];
    for (let i = 0; i < array.length; i++) {
      const resource = valueOf(array, String(i));
      if (!resource || typeof resource !== 'object' || valueOf(resource, '__memoryLabOwner') !== ownerToken) throw Error('uncovered-array-member');
      const token = valueOf(resource, '__memoryLabResource');
      if (typeof token !== 'string' || !token || token.length > 256 || tokens.includes(token)) throw Error('invalid-or-duplicate-resource-token');
      tokens.push(token);
    }
    return { status: 'observed', tokens: tokens.sort(), size: tokens.length };
  } catch (error) { return { status: 'unknown', code: error.message, tokens: null }; }
}

export function observeOwnMethods(owner, propertyKeys, readView, context, emit) {
  if (!Array.isArray(propertyKeys) || !propertyKeys.length || propertyKeys.length > observationPolicy.maxMethods || new Set(propertyKeys).size !== propertyKeys.length) throw Error('Invalid observation method budget');
  if (typeof context?.windowId !== 'string' || typeof context.epochId !== 'string' || !Number.isSafeInteger(context.cycle) || context.cycle < 0 || !Number.isSafeInteger(context.pid) || context.pid < 1 || context.threadId !== 0) throw Error('Invalid primitive observation context');
  context = { windowId: context.windowId, epochId: context.epochId, cycle: context.cycle, pid: context.pid, threadId: context.threadId };
  let saved = [], disposed = false, sequence = 0, emitted = 0, emitFailures = 0, dropped = 0;
  const stack = [], unsupported = [];
  const safeView = () => {
    try {
      const view = readView();
      if (view?.status !== 'observed' || !Array.isArray(view.tokens) || view.tokens.length > observationPolicy.maxMembers || view.tokens.some(t => typeof t !== 'string' || !t || t.length > 256) || new Set(view.tokens).size !== view.tokens.length) return { status: 'unknown', code: 'unsupported-view-result', tokens: null };
      return { status: 'observed', tokens: [...view.tokens].sort(), size: view.tokens.length };
    } catch { return { status: 'unknown', code: 'view-reader-threw', tokens: null }; }
  };
  for (const key of propertyKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key), fn = descriptor?.value;
    if (typeof key !== 'string' || !descriptor?.configurable || typeof fn !== 'function' || Object.prototype.toString.call(fn) !== '[object Function]') { unsupported.push({ propertyKey: key, code: 'unsupported-method-descriptor-or-async' }); continue; }
    const binding = { propertyKey: key, functionTextSha256: digest(Function.prototype.toString.call(fn)) };
    const wrapper = function (...args) {
      const parent = stack.at(-1); if (parent) parent.childCalls++;
      const call = { id: context.windowId + '-' + (++sequence), parentId: parent?.id ?? null, nestedDepth: stack.length, childCalls: 0 };
      const before = safeView(), startedNs = process.hrtime.bigint().toString(); stack.push(call);
      let status = 'returned';
      try {
        const result = Reflect.apply(fn, this, args);
        if ((result !== null && typeof result === 'object') || typeof result === 'function') status = 'unsupported-nonprimitive-result';
        return result;
      } catch (error) { status = 'threw'; throw error; }
      finally {
        const finishedNs = process.hrtime.bigint().toString(), after = safeView(); stack.pop();
        const receiverMatches = this === owner;
        if (!receiverMatches && status === 'returned') status = 'unsupported-receiver';
        const observed = before.status === 'observed' && after.status === 'observed';
        if (!observed && status === 'returned') status = 'unknown-view';
        const event = { ...context, ...call, binding, startedNs, finishedNs, status, receiverMatches, before, after, added: observed ? after.tokens.filter(t => !before.tokens.includes(t)) : [], removed: observed ? before.tokens.filter(t => !after.tokens.includes(t)) : [], interpretation: 'Membership changed during this call window; nested helpers/native operations may perform the write.' };
        if (emitted < observationPolicy.maxEventsPerWindow) { try { emit(event); emitted++; } catch { emitFailures++; } } else dropped++;
      }
    };
    Object.defineProperty(owner, key, { ...descriptor, value: wrapper }); saved.push({ key, descriptor, wrapper, binding });
  }
  const bindings = saved.map(s => ({ ...s.binding }));
  return {
    bindings,
    restore() {
      if (disposed) return { status: 'already-restored', restored: true, bindings, unsupported, emitted, dropped, emitFailures };
      const results = [];
      for (const item of saved) {
        const current = Object.getOwnPropertyDescriptor(owner, item.key);
        if (current?.value !== item.wrapper) results.push({ ...item.binding, restored: false, code: 'method-changed-during-observation' });
        else { Object.defineProperty(owner, item.key, item.descriptor); results.push({ ...item.binding, restored: true }); }
      }
      disposed = true; saved = [];
      return { status: results.every(r => r.restored) ? 'restored' : 'conflict', restored: results.every(r => r.restored), bindings: results, unsupported, emitted, dropped, emitFailures };
    },
  };
}

export function cutTaggedArrayView(owner, property, ownerToken, kind = 'cut') {
  const before = readTaggedArrayView(owner, property, ownerToken), startedNs = process.hrtime.bigint().toString();
  if (!['cut', 'sham'].includes(kind) || before.status !== 'observed') return { status: 'unknown', kind, startedNs, code: 'unsupported-intervention-view', before };
  const array = valueOf(owner, property);
  if (kind === 'cut') array.length = 0;
  const after = readTaggedArrayView(owner, property, ownerToken);
  return { status: after.status === 'observed' ? 'completed' : 'unknown', kind, startedNs, finishedNs: process.hrtime.bigint().toString(), before, after, operation: kind === 'cut' ? 'Set the observed Array length to zero in the synthetic harness' : 'Observe Array membership without changing it', interpretation: 'Controlled collection-edge intervention, not a production cleanup implementation or repair validation.' };
}
