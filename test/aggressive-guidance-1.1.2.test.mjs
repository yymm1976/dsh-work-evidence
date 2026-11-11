import assert from 'node:assert/strict';
import test from 'node:test';
import {AGGRESSIVE_GUIDANCE} from '../task-flow.mjs';

test('1.1.2 aggressive guidance requires same-turn temporary test lifecycle', () => {
  assert.match(AGGRESSIVE_GUIDANCE, /最多创建一个最小自删除复现测试/u);
  assert.match(AGGRESSIVE_GUIDANCE, /与实现修改同一轮创建、运行、删除/u);
  assert.match(AGGRESSIVE_GUIDANCE, /已有测试已覆盖改动行为时可不创建临时测试/u);
  assert.match(AGGRESSIVE_GUIDANCE, /不得留下临时测试、构建产物或未运行文件/u);
});

test('1.1.2 aggressive guidance keeps the valid failing reproduction retention rule', () => {
  assert.match(AGGRESSIVE_GUIDANCE, /测试自身失败最多修正一次/u);
  assert.match(AGGRESSIVE_GUIDANCE, /第二次仍失败则删除临时测试、改用既有测试或静态核对/u);
  assert.match(AGGRESSIVE_GUIDANCE, /不得修改实现去迎合错误预期/u);
});

test('1.1.2 aggressive guidance stops repeated environment failures', () => {
  assert.match(AGGRESSIVE_GUIDANCE, /环境缺少工具链、依赖或离线产物时/u);
  assert.match(AGGRESSIVE_GUIDANCE, /同一命令连续两次失败后停止重试/u);
  assert.match(AGGRESSIVE_GUIDANCE, /不要把环境失败重复成多次请求/u);
});
