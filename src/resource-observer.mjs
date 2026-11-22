export const resourceOperations = Object.freeze(['addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']);
const object = value => value !== null && ['object', 'function'].includes(typeof value);

// Development-only same-realm adapter. Native callback identity changes while installed.
// Metadata contains weak object identities; only native registrations retain callback wrappers.
export function installResourceObserver({ realm = globalThis, registry, epochId, maxEvents = 2048, maxResources = 512 }) {
  if (!epochId || !Array.isArray(registry?.sites) || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 2048 || !Number.isInteger(maxResources) || maxResources < 1 || maxResources > 512) throw Error('invalid-resource-observer-options');
  const proto = realm.EventTarget.prototype, native = { addEventListener: proto.addEventListener, removeEventListener: proto.removeEventListener };
  for (const name of resourceOperations.slice(2)) native[name] = realm[name];
  const sites = new Map(registry.sites.map(site => [site.id, site.operation])), originals = [], records = [], events = [], declarations = [], targets = new WeakMap(), handles = new Map(), objectIds = new WeakMap(), objects = new Map();
  const signalAborted = Object.getOwnPropertyDescriptor(realm.AbortSignal.prototype, 'aborted').get;
  let currentSite = null, dropped = 0, unsupported = 0, unknownSourceCalls = 0, uncertainListeners = false, uncertainTimers = false, nextObject = 1, nextResource = 1, pendingResources = 0;
  function id(value, role) {
    if (!object(value)) return null;
    let key = objectIds.get(value);
    if (!key) { if (objects.size >= 4096) { dropped++; return null; } key = 'o' + nextObject++; objectIds.set(value, key); objects.set(key, { ref: new WeakRef(value), roles: new Set() }); }
    objects.get(key).roles.add(role); return key;
  }
  function note(operation, resource, detail = {}) {
    if (events.length >= maxEvents) { dropped++; return; }
    events.push({ sequence: events.length + 1, operation, siteId: currentSite, resourceId: resource?.id ?? null, ...detail });
  }
  function unknown(operation, reason) { unsupported++; if (operation.includes('EventListener')) uncertainListeners = true; else uncertainTimers = true; note(operation, null, { coverage: 'unsupported', reason }); }
  function locate(operation) { if (currentSite === null) unknownSourceCalls++; else if (sites.get(currentSite) !== operation) throw Error('resource-site-operation-mismatch'); }
  function options(value, add) {
    if (!object(value)) return { capture: Boolean(value), once: false, signal: null, native: value };
    // Web IDL dictionary order. Read each getter once, then pass the normalized dictionary
    // to native; forwarding the original options would execute getters twice.
    const out = { capture: Boolean(value.capture) };
    if (add) {
      out.once = Boolean(value.once);
      const passive = value.passive; if (passive !== undefined) out.passive = Boolean(passive);
      const signal = value.signal; if (signal !== undefined) out.signal = signal;
    }
    return { capture: Boolean(out.capture), once: Boolean(out.once), signal: out.signal ?? null, native: out };
  }
  function mapFor(target, type, listener, create) {
    let types = targets.get(target); if (!types && create) targets.set(target, types = new Map());
    let listeners = types?.get(type); if (!listeners && create) types.set(type, listeners = new WeakMap());
    let captures = listeners?.get(listener); if (!captures && create) listeners.set(listener, captures = new Map());
    return captures;
  }
  function end(record, state, reason, operation = 'automatic-release') {
    if (!['active', 'running'].includes(record.state)) return;
    record.state = state; record.endedBy = reason; record.releaseSiteId = currentSite;
    if (record.kind === 'listener') {
      const target = record.target.deref(), listener = record.listener.deref();
      if (target && listener) mapFor(target, record.type, listener, false)?.delete(record.capture);
    } else if (handles.get(record.handle) === record) handles.delete(record.handle);
    note(operation, record, { state, reason });
  }
  function reconcileSignals() {
    for (const record of records) if (record.kind === 'listener' && record.state === 'active') {
      const signal = record.signal?.deref();
      if (signal && Reflect.apply(signalAborted, signal, [])) {
        const previous = currentSite; currentSite = null;
        try { end(record, 'released', 'abort-signal-observed'); } finally { currentSite = previous; }
      }
    }
  }
  function addEventListener(type, listener, value) {
    locate('addEventListener'); let opts;
    try {
      if (arguments.length < 2 || !(this instanceof realm.EventTarget) || (listener !== null && listener !== undefined && !object(listener))) throw Error('unsupported-listener-arguments');
    } catch (error) { unknown('addEventListener', error.message); return Reflect.apply(native.addEventListener, this, arguments); }
    type = `${type}`; opts = options(value, true);
    if (opts.signal !== null && !(opts.signal instanceof realm.AbortSignal)) { unknown('addEventListener', 'unsupported-abort-signal'); return Reflect.apply(native.addEventListener, this, [type, listener, opts.native]); }
    if (listener == null) { const result = Reflect.apply(native.addEventListener, this, [type, listener, opts.native]); note('addEventListener', null, { outcome: 'ignored-null' }); return result; }
    reconcileSignals();
    const existing = mapFor(this, type, listener, false)?.get(opts.capture), wrapper = existing?.wrapper.deref();
    if (existing?.state === 'active' && wrapper) {
      const result = Reflect.apply(native.addEventListener, this, [type, wrapper, opts.native]);
      note('addEventListener', existing, { outcome: 'duplicate-ignored' }); return result;
    }
    if (opts.signal && Reflect.apply(signalAborted, opts.signal, [])) {
      const result = Reflect.apply(native.addEventListener, this, [type, listener, opts.native]); note('addEventListener', null, { outcome: 'pre-aborted-not-registered' }); return result;
    }
    if (records.length + pendingResources >= maxResources) { unknown('addEventListener', 'resource-budget'); return Reflect.apply(native.addEventListener, this, [type, listener, opts.native]); }
    const record = { id: 'r' + nextResource++, kind: 'listener', state: 'active', registrationSiteId: currentSite, releaseSiteId: null, targetId: id(this, 'target'), callbackId: id(listener, 'callback'), signalId: id(opts.signal, 'signal'), type, capture: opts.capture, once: opts.once, fires: 0, target: new WeakRef(this), listener: new WeakRef(listener), signal: opts.signal ? new WeakRef(opts.signal) : null };
    const callback = function (...args) {
      const previous = currentSite; currentSite = null;
      try {
        record.fires++;
        if (record.once) end(record, 'released', 'once-before-callback');
        note('listener-fired', record);
        if (typeof listener === 'function') return Reflect.apply(listener, this, args);
        const handler = listener.handleEvent;
        if (typeof handler === 'function') return Reflect.apply(handler, listener, args);
      } finally { currentSite = previous; }
    };
    record.wrapper = new WeakRef(callback);
    record.wrapperId = id(callback, 'wrapper');
    const result = Reflect.apply(native.addEventListener, this, [type, callback, opts.native]);
    records.push(record); mapFor(this, type, listener, true).set(opts.capture, record); note('addEventListener', record, { outcome: 'registered' }); return result;
  }
  function removeEventListener(type, listener, value) {
    locate('removeEventListener'); let opts;
    try { if (arguments.length < 2 || !(this instanceof realm.EventTarget) || (listener != null && !object(listener))) throw Error('unsupported-listener-arguments'); }
    catch (error) { unknown('removeEventListener', error.message); return Reflect.apply(native.removeEventListener, this, arguments); }
    type = `${type}`; opts = options(value, false);
    reconcileSignals();
    const record = listener == null ? null : mapFor(this, type, listener, false)?.get(opts.capture), wrapper = record?.wrapper.deref();
    const result = Reflect.apply(native.removeEventListener, this, [type, wrapper ?? listener, opts.native]);
    if (record?.state === 'active' && wrapper) end(record, 'released', 'removeEventListener', 'removeEventListener');
    else note('removeEventListener', record, { outcome: 'no-tracked-registration' });
    return result;
  }
  function schedule(operation, receiver, args) {
    locate(operation);
    if (typeof args[0] !== 'function' || receiver !== realm || records.length + pendingResources >= maxResources) { unknown(operation, records.length + pendingResources >= maxResources ? 'resource-budget' : 'unsupported-timer-callback-or-receiver'); return Reflect.apply(native[operation], receiver, args); }
    const listener = args[0], record = { id: 'r' + nextResource++, kind: operation === 'setTimeout' ? 'timeout' : 'interval', state: 'active', registrationSiteId: currentSite, releaseSiteId: null, callbackId: id(listener, 'callback'), fires: 0, handle: null };
    const callback = function (...values) {
      const previous = currentSite; currentSite = null;
      try {
        record.fires++; note('timer-fired', record);
        if (record.kind === 'timeout') { record.state = 'running'; handles.delete(record.handle); }
        return Reflect.apply(listener, this, values);
      } finally { if (record.kind === 'timeout') end(record, 'completed', 'timeout-callback-completed'); currentSite = previous; }
    };
    record.wrapperId = id(callback, 'wrapper');
    pendingResources++;
    try { record.handle = Reflect.apply(native[operation], receiver, [callback, ...args.slice(1)]); }
    finally { pendingResources--; }
    records.push(record); handles.set(record.handle, record); note(operation, record, { outcome: 'registered', handle: record.handle }); return record.handle;
  }
  function clear(operation, receiver, args) {
    locate(operation); const result = Reflect.apply(native[operation], receiver, args), handle = args[0];
    if (typeof handle !== 'number' || !Number.isInteger(handle) || handle < 0) { unknown(operation, 'unsupported-timer-handle'); return result; }
    const record = handles.get(handle);
    if (record) end(record, 'released', operation, operation); else note(operation, null, { outcome: 'no-active-handle', handle });
    return result;
  }
  const replacements = { addEventListener, removeEventListener, setTimeout: function (...args) { return schedule('setTimeout', this ?? realm, args); }, setInterval: function (...args) { return schedule('setInterval', this ?? realm, args); }, clearTimeout: function (...args) { return clear('clearTimeout', this ?? realm, args); }, clearInterval: function (...args) { return clear('clearInterval', this ?? realm, args); } };
  for (const name of resourceOperations) {
    const receiver = name.includes('EventListener') ? proto : realm, descriptor = Object.getOwnPropertyDescriptor(receiver, name);
    originals.push({ receiver, name, descriptor }); Object.defineProperty(receiver, name, { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: replacements[name] });
  }
  function prepare(siteId, receiver, operation) {
    const method = receiver[operation];
    return function (...args) {
      const previous = currentSite; currentSite = siteId;
      try {
        if (sites.get(siteId) !== operation) throw Error('resource-site-operation-mismatch');
        if (method !== replacements[operation]) unknown(operation, 'overridden-or-unrecognized-method');
        return Reflect.apply(method, receiver, args);
      } catch (error) {
        note(operation, null, { outcome: 'threw', callbackId: object(args[1]) ? objectIds.get(args[1]) ?? null : null, message: error?.message ?? String(error) });
        throw error;
      } finally { currentSite = previous; }
    };
  }
  // Only objects allocated in these private slots are accounted for. Never follow
  // arbitrary properties, WeakRef referents, callback closures or business values.
  // The returned list is temporary; callers must release it before the final heap.
  function probeOwnedObjects() {
    function* slots() {
      for (const [value, kind] of [[sites, 'site-index'], [originals, 'original-descriptors'], [records, 'resource-records'], [events, 'event-records'], [declarations, 'declarations'], [targets, 'target-index'], [handles, 'timer-index'], [objectIds, 'object-id-index'], [objects, 'identity-records'], [native, 'native-methods'], [replacements, 'replacement-methods']]) yield { value, kind };
      for (const record of originals) { yield { value: record, kind: 'original-descriptor-record' }; if (record.descriptor) yield { value: record.descriptor, kind: 'property-descriptor' }; }
      for (const record of events) yield { value: record, kind: 'event-record' };
      for (const record of declarations) yield { value: record, kind: 'declaration-record' };
      for (const record of objects.values()) {
        yield { value: record, kind: 'identity-record' };
        yield { value: record.ref, kind: 'identity-weak-ref' };
        yield { value: record.roles, kind: 'identity-role-set' };
      }
      for (const record of records) {
        yield { value: record, kind: 'resource-record' };
        if (record.kind !== 'listener') continue;
        for (const key of ['target', 'listener', 'wrapper', 'signal']) if (record[key]) yield { value: record[key], kind: 'listener-' + key + '-weak-ref' };
        const target = record.target.deref(), listener = record.listener.deref(), types = target && targets.get(target);
        if (!types) continue;
        yield { value: types, kind: 'event-type-index' };
        for (const index of types.values()) yield { value: index, kind: 'listener-index' };
        const captures = listener && types.get(record.type)?.get(listener);
        if (captures) yield { value: captures, kind: 'capture-index' };
      }
    }
    const owned = [], seen = new Set(), maxObjects = 8192; let complete = true;
    for (const entry of slots()) {
      if (seen.has(entry.value)) continue;
      if (owned.length === maxObjects) { complete = false; break; }
      seen.add(entry.value); owned.push(entry);
    }
    return { objects: owned, complete, limits: { maxObjects, scope: 'Explicit private slots only; not whole-heap ownership. Callback functions and unknown objects remain in the graph and candidate census.' } };
  }
  return {
    prepare,
    probeOwnedObjects,
    resolve: key => objects.get(key)?.ref.deref(),
    trackObject(value, label, role = 'target') {
      if (!object(value) || typeof label !== 'string' || !label || label.length > 128 || !['target', 'holder'].includes(role)) throw Error('invalid-resource-object-declaration');
      const existing = declarations.find(value => value.label === label);
      if (existing) { if (objects.get(existing.objectId)?.ref.deref() !== value || existing.role !== role) throw Error('resource-declaration-label-reused'); return existing.objectId; }
      if (declarations.length >= 64) throw Error('resource-declaration-budget');
      const objectId = id(value, 'declared-' + role); if (objectId === null) return null;
      declarations.push({ label, role, objectId }); return objectId;
    },
    report() {
      const previous = currentSite; currentSite = null; try { reconcileSignals(); } finally { currentSite = previous; }
      const resources = records.map(({ target, listener, wrapper, signal, ...record }) => {
        const unavailable = record.kind === 'listener' && record.state === 'active' && target.deref() === undefined;
        return { ...record, ...(unavailable ? { state: 'target-unavailable', lastObservedState: record.state } : {}), stateCertain: !unavailable && !(record.kind === 'listener' ? uncertainListeners : uncertainTimers) };
      });
      const unavailableActiveTargets = resources.filter(record => record.state === 'target-unavailable').length;
      return { schemaVersion: '0.1.0', adapter: 'browser-resources', epochId, resources, declarations: declarations.map(value => ({ ...value })), events: events.map(event => ({ ...event })), objects: [...objects].map(([key, value]) => ({ id: key, roles: [...value.roles], weakResolution: value.ref.deref() === undefined ? 'cleared' : 'available' })), coverage: { completeWithinScope: unsupported === 0 && dropped === 0 && unavailableActiveTargets === 0, unsupported, dropped, unavailableActiveTargets, unknownSourceCalls, maxEvents, maxResources, maxObjects: 4096 },
        interpretation: 'Native registration semantics observed through a development adapter. Active/released/completed describe registration or timer execution, not object GC or certified retaining paths. Source unknown remains visible. Exotic options, nonfunction timers, pre-existing registrations and modified intrinsics are outside scope.' };
    },
    restore() {
      reconcileSignals(); if (records.some(record => ['active', 'running'].includes(record.state))) throw Error('active-resource-restore-refused');
      for (const { receiver, name, descriptor } of originals) if (descriptor) Object.defineProperty(receiver, name, descriptor); else delete receiver[name];
    },
  };
}
