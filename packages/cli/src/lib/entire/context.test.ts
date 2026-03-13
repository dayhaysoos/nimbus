import { strict as assert } from 'assert';
import { isValidEntireSessionId, selectEntireCheckpointsRef } from './context.js';

export function runEntireIntentContextTests(): void {
  assert.equal(isValidEntireSessionId('ses_abc123XYZ-09'), true);
  assert.equal(isValidEntireSessionId('session-id_underscore'), true);

  assert.equal(isValidEntireSessionId(''), false);
  assert.equal(isValidEntireSessionId('ses/../../etc'), false);
  assert.equal(isValidEntireSessionId('../ses_abc'), false);
  assert.equal(isValidEntireSessionId('/tmp/ses_abc'), false);
  assert.equal(isValidEntireSessionId('ses with space'), false);
  assert.equal(isValidEntireSessionId('ses:colon'), false);
  assert.equal(isValidEntireSessionId(`ses_${'x'.repeat(200)}`), false);

  {
    const available = new Set<string>(['refs/remotes/origin/entire/checkpoints/v1']);
    const selected = selectEntireCheckpointsRef((ref) => available.has(ref));
    assert.equal(selected, 'refs/remotes/origin/entire/checkpoints/v1');
  }

  {
    const available = new Set<string>(['entire/checkpoints/v1', 'refs/remotes/origin/entire/checkpoints/v1']);
    const selected = selectEntireCheckpointsRef((ref) => available.has(ref));
    assert.equal(selected, 'entire/checkpoints/v1');
  }

  {
    const selected = selectEntireCheckpointsRef(() => false);
    assert.equal(selected, null);
  }
}
