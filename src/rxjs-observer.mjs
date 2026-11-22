import { types } from 'node:util';
import { createRxjsObserver as createCoreObserver } from './rxjs-observer-core.mjs';
export { rxjsObservationLimits } from './rxjs-observer-core.mjs';
export function createRxjsObserver(options) { return createCoreObserver({ ...options, isProxy: types.isProxy }); }
