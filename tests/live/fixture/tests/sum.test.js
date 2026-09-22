import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src-sum.js';
test('REQ-1 soma dois números', () => { assert.equal(sum(40, 2), 42); });
