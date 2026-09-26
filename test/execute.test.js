import test from 'node:test';
import assert from 'node:assert/strict';
import { detectsIncompleteAnswer } from '../src/execute.js';

test('detects an explicit inability to access requested files', () => {
  assert.equal(detectsIncompleteAnswer('파일 읽기 도구가 현재 제공되지 않아 내용을 요약하기 어렵습니다. 내용을 붙여 주시면 도와드릴게요.'), true);
  assert.equal(detectsIncompleteAnswer('I cannot access the repository files from this session.'), true);
});

test('does not mark a completed summary as incomplete', () => {
  assert.equal(detectsIncompleteAnswer('이 프로젝트는 요청을 분류해 적절한 Codex 모델을 선택하는 도구입니다.'), false);
});
