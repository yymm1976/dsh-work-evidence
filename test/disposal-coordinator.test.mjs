import test from 'node:test';
import assert from 'node:assert/strict';
import {createDisposalCoordinator} from '../disposal-coordinator.mjs';

test('session disposal waits for an in-flight agent cleanup before releasing state',async()=>{
  const disposed=[],order=[];
  const coordinator=createDisposalCoordinator(id=>{disposed.push(id);order.push('dispose');});
  let release;
  const cleanup=new Promise(resolve=>{release=resolve;});
  const pending=coordinator.agentDisposed('s1',async()=>{await cleanup;order.push('cleanup');});
  const session=coordinator.sessionDisposed('s1');
  assert.deepEqual(disposed,[],'runtime state must survive until the async cleanup finishes');
  assert.equal(order.includes('cleanup'),false);
  release();
  await Promise.all([pending,session]);
  assert.deepEqual(order,['cleanup','dispose']);
  assert.deepEqual(disposed,['s1']);
  assert.equal(coordinator.hasPending('s1'),false);
});

test('a session without an agent is disposed immediately',async()=>{
  const disposed=[];
  const coordinator=createDisposalCoordinator(id=>disposed.push(id));
  await coordinator.sessionDisposed('no-agent');
  assert.deepEqual(disposed,['no-agent']);
});

test('a failing agent cleanup still releases the session and does not throw',async()=>{
  const disposed=[];
  const coordinator=createDisposalCoordinator(id=>disposed.push(id));
  const pending=coordinator.agentDisposed('bad',async()=>{throw new Error('telemetry unavailable');});
  assert.deepEqual(await pending,{ok:false,error:new Error('telemetry unavailable')});
  await coordinator.sessionDisposed('bad');
  assert.deepEqual(disposed,['bad']);
  assert.equal(coordinator.hasPending('bad'),false);
});
