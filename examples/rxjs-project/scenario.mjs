export const name = 'example-panel-three-lifecycles';
export async function setup() {}
export async function action(page) { await page.evaluate(() => globalThis.__memoryLabApp.mount()); }
export async function back(page) { await page.evaluate(() => globalThis.__memoryLabApp.unmount()); }
export async function assertBaseline(page) { return page.evaluate(() => globalThis.__memoryLabApp.state()); }
export async function followup(page) { await page.waitForTimeout(50); }
