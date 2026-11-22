import { Subject, Subscription } from 'rxjs';
export const bus = new Subject<number>();
class PanelPayload { data = new Array(128).fill(1); }
function callback(resource: PanelPayload) { return () => resource.data.length; }
export function subscribePanel(): Subscription { return bus.subscribe(callback(new PanelPayload())); }
export function closePanel(subscription: Subscription): void { subscription.unsubscribe(); }
