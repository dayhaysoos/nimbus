import type { JobPhase, JobStatus } from '../types.js';

const STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  failed: ['running'],
  completed: [],
  cancelled: [],
};

const PHASE_TRANSITIONS: Record<JobPhase, readonly JobPhase[]> = {
  queued: ['planning', 'failed', 'cancelled'],
  planning: ['generating', 'failed', 'cancelled'],
  generating: ['building', 'repairing', 'failed', 'cancelled'],
  building: ['validating', 'repairing', 'failed', 'cancelled'],
  repairing: ['building', 'failed', 'cancelled'],
  validating: ['deploying', 'repairing', 'failed', 'cancelled'],
  deploying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: JobStatus): boolean {
  return STATUS_TRANSITIONS[status].length === 0;
}

export function isTerminalPhase(phase: JobPhase): boolean {
  return PHASE_TRANSITIONS[phase].length === 0;
}

export function canTransitionStatus(from: JobStatus, to: JobStatus): boolean {
  if (from === to) {
    return true;
  }

  return STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionPhase(from: JobPhase, to: JobPhase): boolean {
  if (from === to) {
    return true;
  }

  return PHASE_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionStatus(from, to)) {
    throw new Error(`Invalid job status transition: ${from} -> ${to}`);
  }
}

export function assertPhaseTransition(from: JobPhase, to: JobPhase): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(`Invalid job phase transition: ${from} -> ${to}`);
  }
}

export function phaseForStatus(status: JobStatus): JobPhase {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'planning';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function getAllowedStatusTransitions(status: JobStatus): readonly JobStatus[] {
  return STATUS_TRANSITIONS[status];
}

export function getAllowedPhaseTransitions(phase: JobPhase): readonly JobPhase[] {
  return PHASE_TRANSITIONS[phase];
}
