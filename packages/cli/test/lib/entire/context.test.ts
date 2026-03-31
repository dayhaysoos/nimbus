import { strict as assert } from 'assert';
import { extractEntireTranscriptText, isValidEntireSessionId, selectEntireCheckpointsRef } from '../../../src/lib/entire/context.js';

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

  {
    const transcript = JSON.stringify({
      messages: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'First request.' }],
        },
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'Assistant reply.' }],
        },
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'Second request.' }],
        },
      ],
    });

    assert.deepEqual(extractEntireTranscriptText(transcript), {
      contextText: 'First request.\n\n---\n\nSecond request.',
      rawPromptText: 'First request.\n\n---\n\nSecond request.',
    });
  }

  {
    assert.equal(extractEntireTranscriptText('{"messages":[]}'), null);
    assert.equal(extractEntireTranscriptText('not json'), null);
  }
}
