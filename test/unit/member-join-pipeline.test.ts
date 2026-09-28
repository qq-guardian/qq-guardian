import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runMemberJoinPipeline,
  type MemberJoinStage,
} from '../../src/application/member-join.ts';
import type { MemberJoinEvent } from '../../src/types/member-join.ts';

const join: MemberJoinEvent = {
  groupId: '10001',
  userId: '20002',
  subType: 'invite',
  timestamp: 1,
};

function stage(
  name: string,
  calls: string[],
  result: 'continue' | 'stop' = 'continue'
): MemberJoinStage {
  return {
    name,
    async run() {
      calls.push(name);
      return result;
    },
  };
}

describe('member-join pipeline', () => {
  it('runs admission stages in their declared order', async () => {
    const calls: string[] = [];

    const result = await runMemberJoinPipeline(join, [
      stage('blacklist', calls),
      stage('punishment', calls),
      stage('intel', calls),
      stage('welcome', calls),
    ]);

    assert.deepEqual(calls, ['blacklist', 'punishment', 'intel', 'welcome']);
    assert.deepEqual(result, { status: 'completed' });
  });

  it('short-circuits later side effects after terminal enforcement', async () => {
    const calls: string[] = [];

    const result = await runMemberJoinPipeline(join, [
      stage('blacklist', calls, 'stop'),
      stage('punishment', calls),
      stage('intel', calls),
      stage('welcome', calls),
    ]);

    assert.deepEqual(calls, ['blacklist']);
    assert.deepEqual(result, { status: 'stopped', stage: 'blacklist' });
  });

  it('fails closed when an enforcement stage throws', async () => {
    const calls: string[] = [];
    const errors: Array<{ stage: string; error: unknown }> = [];

    const result = await runMemberJoinPipeline(
      join,
      [
        {
          name: 'punishment',
          async run() {
            calls.push('punishment');
            throw new Error('OneBot unavailable');
          },
        },
        stage('welcome', calls),
      ],
      (stageName, error) => errors.push({ stage: stageName, error })
    );

    assert.deepEqual(calls, ['punishment']);
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'punishment');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].stage, 'punishment');
    assert.ok(errors[0].error instanceof Error);
    assert.match(errors[0].error.message, /OneBot unavailable/);
  });
});
