
export const rxjsObservationLimits = Object.freeze({ maxEvents: 512, maxObjects: 256, maxSourceDepth: 16, maxSubjectMembers: 64, adapter: 'rxjs-7.8.1' });
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
function closed(value) {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'closed');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') throw Error('unsupported-closed-property');
  return descriptor.value;
}

// Opt-in call-site adapter. No prototype patching, callback wrapping or injected teardown.
export function createRxjsObserver({ rxjs, version, registry, epochId, maxEvents = 512, maxObjects = 256, isProxy = () => false }) {
  if (version !== '7.8.1' || !rxjs?.Observable || !rxjs?.Subscription || !rxjs?.Subscriber || !rxjs?.Subject) throw Error('unsupported-rxjs-version-or-module');
  if (typeof epochId !== 'string' || !epochId || !Array.isArray(registry?.sites) || !Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > 512 || !Number.isSafeInteger(maxObjects) || maxObjects < 0 || maxObjects > 256) throw Error('invalid-observer-options');
  const subscribe = rxjs.Observable.prototype.subscribe;
  const unsubscribe = new Set([rxjs.Subscription.prototype.unsubscribe, rxjs.Subscriber.prototype.unsubscribe]);
  const sites = new Map(registry.sites.map(site => [site.id, site.operation]));
  const objects = new WeakMap(), weak = new Map(), events = [];
  const anonymousSubjectPrototype = Object.getPrototypeOf(rxjs.Subject.create());
  const subjectPrototypes = new Map(['Subject', 'BehaviorSubject', 'ReplaySubject', 'AsyncSubject'].filter(kind => rxjs[kind]?.prototype).map(kind => [rxjs[kind].prototype, kind]));
  let dropped = 0, unsupported = 0, typeAnchors = null;
  function identity(value, role) {
    if (!object(value) || isProxy(value)) throw Error('unsupported-object');
    let id = objects.get(value);
    if (!id) {
      if (weak.size >= maxObjects) throw Error('object-budget');
      id = 'o' + (weak.size + 1); objects.set(value, id); weak.set(id, { ref: new WeakRef(value), roles: new Set() });
    }
    weak.get(id).roles.add(role); return id;
  }
  function unknown(event, reason) {
    if (event.coverage !== 'unsupported') unsupported++;
    event.coverage = 'unsupported'; event.reason = reason;
  }
  function captureTypeAnchors() {
    if (typeAnchors) return;
    typeAnchors = { schemaVersion: '0.1.0', status: 'unavailable', subjectPrototypeId: null, subscriberPrototypeId: null, reason: null };
    try {
      typeAnchors.subjectPrototypeId = identity(rxjs.Subject.prototype, 'type-prototype');
      typeAnchors.subscriberPrototypeId = identity(rxjs.Subscriber.prototype, 'type-prototype');
      typeAnchors.status = 'available';
    } catch (error) { typeAnchors.reason = error.message; }
    if (typeAnchors.status === 'available') {
      typeAnchors.subjectKindPrototypeIds = {};
      for (const [prototype, kind] of subjectPrototypes) if (kind !== 'Subject') {
        try { typeAnchors.subjectKindPrototypeIds[kind] = identity(prototype, 'type-prototype'); }
        catch { break; } // Missing optional anchors leave that kind outside offline coverage.
      }
    }
  }
  function data(value, key, required = true) {
    if (!object(value) || isProxy(value)) throw Error('lineage-nonordinary-object');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) { if (required) throw Error('lineage-missing-' + key); return undefined; }
    if (!Object.hasOwn(descriptor, 'value')) throw Error('lineage-accessor-' + key);
    return descriptor.value;
  }
  function sourceLineage(receiver) {
    const lineage = { schemaVersion: '0.1.0', status: 'unconfirmed', scope: 'primary-source-only', sourceIds: [], subjectId: null, membership: null, reason: null };
    try {
      const seen = new Set(); let current = receiver;
      for (let depth = 0; depth <= rxjsObservationLimits.maxSourceDepth; depth++) {
        if (!object(current) || isProxy(current) || seen.has(current)) throw Error('lineage-nonordinary-or-cyclic-source');
        seen.add(current);
        const prototype = Object.getPrototypeOf(current);
        if (![rxjs.Observable.prototype, anonymousSubjectPrototype].includes(prototype) && !subjectPrototypes.has(prototype)) throw Error('lineage-unsupported-prototype');
        if (Object.getOwnPropertyDescriptor(current, '_subscribe')) throw Error('lineage-custom-subscribe');
        const id = identity(current, 'source'); lineage.sourceIds.push(id);
        if (subjectPrototypes.has(prototype) && !Object.getOwnPropertyDescriptor(current, 'source')) {
          if (typeof data(current, 'closed') !== 'boolean' || typeof data(current, 'isStopped') !== 'boolean' || !Array.isArray(data(current, 'observers'))) throw Error('lineage-unsupported-subject');
          lineage.subjectId = id; lineage.subjectKind = subjectPrototypes.get(prototype); return lineage;
        }
        const operator = data(current, 'operator', false);
        if (operator !== undefined && typeof operator !== 'function') throw Error('lineage-unsupported-operator');
        current = data(current, 'source');
      }
      throw Error('lineage-source-depth-budget');
    } catch (error) { lineage.status = 'unsupported'; lineage.reason = error.message; return lineage; }
  }
  function confirmMembership(lineage, subscription) {
    if (lineage.status === 'unsupported') return;
    try {
      const subject = weak.get(lineage.subjectId)?.ref.deref(), members = data(subject, 'observers');
      if (!Array.isArray(members) || isProxy(members) || Object.getPrototypeOf(members) !== Array.prototype) throw Error('lineage-unsupported-members');
      const length = data(members, 'length');
      if (!Number.isSafeInteger(length) || length > rxjsObservationLimits.maxSubjectMembers) throw Error('lineage-membership-budget');
      for (let i = 0; i < length; i++) {
        let current = data(members, String(i)); const seen = new Set(), subscriberIds = [];
        for (let depth = 0; depth <= rxjsObservationLimits.maxSourceDepth; depth++) {
          if (!object(current) || isProxy(current) || !(current instanceof rxjs.Subscriber) || seen.has(current)) break;
          seen.add(current); subscriberIds.push(identity(current, 'subscription'));
          if (current === subscription) {
            lineage.status = 'observed'; lineage.membership = { memberId: subscriberIds[0], subscriberIds }; return;
          }
          current = data(current, 'destination');
        }
      }
      lineage.reason = 'no-membership-at-subscribe-return';
    } catch (error) { lineage.status = 'unsupported'; lineage.reason = error.message; }
  }
  function prepare(siteId, receiver, operation) {
    // Same lookup order as receiver.method(args): resolve the original method before args.
    const method = receiver[operation];
    return function (...args) {
      if (events.length >= maxEvents) { dropped++; return Reflect.apply(method, receiver, args); }
      const event = { sequence: events.length + 1, siteId, operation, coverage: 'supported', outcome: 'pending', receiverId: null, subscriptionId: null, observerIds: [], closedBefore: null, closedAfter: null };
      events.push(event); // Start order remains stable when a callback makes nested calls.
      try {
        if (sites.get(siteId) !== operation) throw Error('unknown-site-or-operation');
        if (!object(receiver) || isProxy(receiver)) throw Error('unsupported-receiver');
        if (operation === 'subscribe') {
          if (method !== subscribe || !(receiver instanceof rxjs.Observable)) throw Error('unsupported-subscribe-method');
          event.receiverId = identity(receiver, 'source');
          for (const argument of args.slice(0, 3)) if (object(argument)) event.observerIds.push(identity(argument, 'observer'));
          event.observerIds = [...new Set(event.observerIds)];
          event.sourceLineage = sourceLineage(receiver);
          captureTypeAnchors();
        } else if (operation === 'unsubscribe') {
          if (!unsubscribe.has(method) || !(receiver instanceof rxjs.Subscription)) throw Error('unsupported-unsubscribe-method');
          event.receiverId = event.subscriptionId = identity(receiver, 'subscription');
          event.closedBefore = closed(receiver);
        } else throw Error('unsupported-operation');
      } catch (error) { unknown(event, error.message); }
      let result;
      try { result = Reflect.apply(method, receiver, args); event.outcome = 'returned'; return result; }
      catch (error) { event.outcome = 'threw'; throw error; }
      finally {
        if (event.coverage === 'supported') {
          try {
            if (operation === 'subscribe' && event.outcome === 'returned') {
              if (!object(result) || isProxy(result) || !(result instanceof rxjs.Subscription)) throw Error('unsupported-subscription-result');
              event.subscriptionId = identity(result, 'subscription'); event.closedAfter = closed(result);
              confirmMembership(event.sourceLineage, result);
            } else if (operation === 'unsubscribe') event.closedAfter = closed(receiver);
          } catch (error) { unknown(event, error.message); }
        }
      }
    };
  }
  return {
    prepare,
    resolve: id => { const entry = weak.get(id); if (!entry) throw Error('unregistered-weak-id'); return entry.ref.deref(); },
    report: () => ({ schemaVersion: '0.1.0', adapter: rxjsObservationLimits.adapter, epochId, weakIdentityProtocol: 'registered-weakref-v1',
      typeAnchors: typeAnchors ? { ...typeAnchors, ...(typeAnchors.subjectKindPrototypeIds ? { subjectKindPrototypeIds: { ...typeAnchors.subjectKindPrototypeIds } } : {}) } : { schemaVersion: '0.1.0', status: 'unavailable', subjectPrototypeId: null, subscriberPrototypeId: null, reason: 'no-supported-subscribe' },
      events: events.map(event => ({ ...event, observerIds: [...event.observerIds], ...(event.sourceLineage ? { sourceLineage: { ...event.sourceLineage, sourceIds: [...event.sourceLineage.sourceIds], membership: event.sourceLineage.membership ? { ...event.sourceLineage.membership, subscriberIds: [...event.sourceLineage.membership.subscriberIds] } : null } } : {}) })),
      objects: [...weak].map(([id, value]) => ({ id, roles: [...value.roles] })), dropped, unsupported,
      completeWithinScope: dropped === 0 && unsupported === 0, limits: { maxEvents, maxObjects },
      interpretation: 'Observed public call sites only. Source lineage records ordinary RxJS 7.8.1 primary source descriptors and actual Subject-member-to-returned-Subscriber destination links at subscribe return. Weak type anchors allow a separate bounded final-heap membership analysis; they do not enumerate all operator sources at runtime. closed is not release; internal automatic unsubscribe calls are not instrumented.' }),
  };
}
