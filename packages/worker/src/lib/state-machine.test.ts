import { strict as assert } from 'assert';
import {
  assertPhaseTransition,
  assertStatusTransition,
  canTransitionPhase,
  canTransitionStatus,
  isTerminalPhase,
  isTerminalStatus,
  phaseForStatus,
} from './state-machine.js';

export function runStateMachineTests(): void {
  assert.equal(canTransitionStatus('queued', 'running'), true);
  assert.equal(canTransitionStatus('running', 'completed'), true);
  assert.equal(canTransitionStatus('running', 'failed'), true);
  assert.equal(canTransitionStatus('failed', 'running'), true);
  assert.equal(canTransitionStatus('running', 'cancelled'), true);

  assert.equal(canTransitionStatus('queued', 'completed'), false);
  assert.equal(canTransitionStatus('completed', 'running'), false);
  assert.equal(canTransitionStatus('cancelled', 'running'), false);

  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('cancelled'), true);
  assert.equal(isTerminalStatus('queued'), false);

  assert.throws(
    () => assertStatusTransition('queued', 'completed'),
    /Invalid job status transition: queued -> completed/
  );

  assert.equal(canTransitionPhase('building', 'repairing'), true);
  assert.equal(canTransitionPhase('repairing', 'building'), true);

  assert.equal(canTransitionPhase('queued', 'planning'), true);
  assert.equal(canTransitionPhase('planning', 'generating'), true);
  assert.equal(canTransitionPhase('generating', 'building'), true);
  assert.equal(canTransitionPhase('building', 'validating'), true);
  assert.equal(canTransitionPhase('validating', 'deploying'), true);
  assert.equal(canTransitionPhase('deploying', 'completed'), true);

  assert.equal(canTransitionPhase('queued', 'deploying'), false);
  assert.equal(canTransitionPhase('completed', 'deploying'), false);
  assert.equal(canTransitionPhase('cancelled', 'planning'), false);

  assert.equal(isTerminalPhase('completed'), true);
  assert.equal(isTerminalPhase('failed'), true);
  assert.equal(isTerminalPhase('cancelled'), true);
  assert.equal(isTerminalPhase('planning'), false);

  assert.throws(
    () => assertPhaseTransition('queued', 'deploying'),
    /Invalid job phase transition: queued -> deploying/
  );

  assert.equal(phaseForStatus('queued'), 'queued');
  assert.equal(phaseForStatus('running'), 'planning');
  assert.equal(phaseForStatus('completed'), 'completed');
  assert.equal(phaseForStatus('failed'), 'failed');
  assert.equal(phaseForStatus('cancelled'), 'cancelled');
}
