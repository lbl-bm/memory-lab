import test from 'node:test';
import assert from 'node:assert/strict';
import { countObjectsByPrototype } from '../src/diagnostics.mjs';
test('diagnostic query releases all strong remote handles after success and failure', async () => {
  for (const fail of [false, true]) {
    const commands = [];
    const cdp = { send: async (command, params) => {
      commands.push([command, params]);
      if (command === 'Runtime.evaluate') return { result: { objectId: 'prototype' } };
      if (command === 'Runtime.queryObjects') {
        if (fail) throw new Error('query failed');
        return { objects: { objectId: 'array' } };
      }
      if (command === 'Runtime.callFunctionOn') return { result: { value: 3 } };
      return {};
    } };
    if (fail) await assert.rejects(countObjectsByPrototype(cdp, 'prototype'), /query failed/);
    else assert.equal((await countObjectsByPrototype(cdp, 'prototype')).liveInstances, 3);
    assert.equal(commands.at(-1)[0], 'Runtime.releaseObjectGroup');
    assert.equal(commands.at(-1)[1].objectGroup, commands[0][1].objectGroup);
  }
});
