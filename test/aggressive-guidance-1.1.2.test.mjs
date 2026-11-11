import assert from 'node:assert/strict';
import test from 'node:test';
import {AGGRESSIVE_GUIDANCE} from '../task-flow.mjs';

test('1.1.2 aggressive guidance requires same-turn temporary test lifecycle', () => {
  assert.match(AGGRESSIVE_GUIDANCE, /优先运行仓库既有测试中覆盖改动的最小集合/u);
  assert.match(AGGRESSIVE_GUIDANCE, /仅当既有测试无法触达改动行为且存在可执行测试入口时/u);
  assert.match(AGGRESSIVE_GUIDANCE, /与实现修改同一轮完成、运行一次后立即删除/u);
  assert.match(AGGRESSIVE_GUIDANCE, /不得留下临时测试、构建产物或未运行文件/u);
});

test('1.1.2 aggressive guidance keeps the valid failing reproduction retention rule', () => {
  assert.match(AGGRESSIVE_GUIDANCE, /测试自身失败最多修正一次/u);
  assert.match(AGGRESSIVE_GUIDANCE, /第二次仍失败则删除临时测试、改用既有测试或静态核对/u);
  assert.match(AGGRESSIVE_GUIDANCE, /不得修改实现去迎合错误预期/u);
});
