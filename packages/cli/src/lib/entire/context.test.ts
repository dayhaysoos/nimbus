import { strict as assert } from 'assert';
import { isValidEntireSessionId } from './context.js';

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
}
