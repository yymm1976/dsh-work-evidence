import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheAdvance} from '../context-pruning.mjs';

// The live-session annotations that decide whether a body may be hidden must advance with
// the event log. Computing them once froze the first step's view, so a later complete read
// could never supersede an earlier body, and a file edited after the first prune never
// became a working target.

const counter=()=>({
  initial:()=>new Map(),
  apply(state,events){for(const event of events)state.set(event.file,(state.get(event.file)??0)+1);},
});

test('the annotation advances with newly appended events',()=>{
  const cache=new Map(),consume=counter();
  const events=[{file:'a.py'}];
  assert.equal(cacheAdvance(cache,'s',events,consume).get('a.py'),1,'the first call sees one event');
  events.push({file:'a.py'});
  assert.equal(cacheAdvance(cache,'s',events,consume).get('a.py'),2,'a later event is folded in');
  events.push({file:'b.py'});
  const state=cacheAdvance(cache,'s',events,consume);
  assert.equal(state.get('a.py'),2,'the earlier count is kept');
  assert.equal(state.get('b.py'),1,'the new path is added');
  assert.equal(cache.get('s').cursor,events.length,'the cursor tracks the log length');
});

test('a replaced session log rebuilds instead of keeping stale counts',()=>{
  const cache=new Map(),consume=counter();
  const events=[{file:'a.py'},{file:'a.py'}];
  assert.equal(cacheAdvance(cache,'s',events,consume).get('a.py'),2);
  const replaced=[{file:'z.py'}];
  const state=cacheAdvance(cache,'s',replaced,consume);
  assert.equal(state.get('a.py'),undefined,'counts from the old session are dropped');
  assert.equal(state.get('z.py'),1);
});

test('sessions do not share annotations',()=>{
  const cache=new Map(),consume=counter();
  assert.equal(cacheAdvance(cache,'one',[{file:'a.py'}],consume).get('a.py'),1);
  assert.equal(cacheAdvance(cache,'two',[{file:'a.py'},{file:'a.py'}],consume).get('a.py'),2);
  assert.equal(cacheAdvance(cache,'one',[{file:'a.py'}],consume).get('a.py'),1,'the first session is unchanged');
});
