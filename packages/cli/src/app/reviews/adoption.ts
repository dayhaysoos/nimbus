import * as p from '@clack/prompts';
import type { ReviewSessionPhase, ReviewSessionResponse } from '../../lib/types.js';
import {
  materializeReviewSessionCommand,
  type MaterializeReviewSessionResult,
  type ReviewSessionMaterializeMode,
} from './materialize.js';

type AdoptionChoice = 'worktree' | 'branch' | 'not_now';
type AdoptionSelect = (options: {
  message: string;
  options: Array<{ value: AdoptionChoice; label: string; hint?: string }>;
}) => Promise<unknown>;

function defaultIsInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

let materializeReviewSessionForAdoption: typeof materializeReviewSessionCommand = materializeReviewSessionCommand;
let isInteractiveForAdoption: () => boolean = defaultIsInteractive;
let selectForAdoption: AdoptionSelect = async (options) => p.select(options);

export function setReviewSessionAdoptionFlowForTests(
  overrides:
    | {
        materializeReviewSession?: typeof materializeReviewSessionCommand;
        isInteractive?: () => boolean;
        select?: AdoptionSelect;
      }
    | null
): void {
  materializeReviewSessionForAdoption = overrides?.materializeReviewSession ?? materializeReviewSessionCommand;
  isInteractiveForAdoption = overrides?.isInteractive ?? defaultIsInteractive;
  selectForAdoption = overrides?.select ?? (async (options) => p.select(options));
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function isTerminalReviewSessionPhase(phase: ReviewSessionPhase | string | null | undefined): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled' || phase === 'waiting_on_human';
}

export function shouldOfferReviewSessionAdoption(session: ReviewSessionResponse | null | undefined): boolean {
  if (!session?.outcome) {
    return false;
  }

  return isTerminalReviewSessionPhase(session.phase) && session.outcome.materializeReady;
}

function hasAdoptableReviewSession(session: ReviewSessionResponse | null | undefined): session is ReviewSessionResponse {
  return shouldOfferReviewSessionAdoption(session);
}

function renderAdoptionSummary(session: ReviewSessionResponse): void {
  const outcome = session.outcome;
  if (!outcome) {
    return;
  }

  const changedFiles = outcome.changes.changedFileCount;
  console.log('');
  p.log.message(
    `Nimbus prepared verified changes in review session ${session.id} (${pluralize(changedFiles, 'changed file')}).`
  );
}

export async function maybeOfferReviewSessionAdoption(
  session: ReviewSessionResponse | null | undefined
): Promise<MaterializeReviewSessionResult | null> {
  if (!hasAdoptableReviewSession(session)) {
    return null;
  }

  const readySession = session;

  renderAdoptionSummary(readySession);

  if (!isInteractiveForAdoption()) {
    p.log.message(`Bring them local with: nimbus review session adopt ${readySession.id}`);
    p.log.message(`Or create only a branch with: nimbus review session adopt ${readySession.id} --branch-only`);
    return null;
  }

  const selection = await selectForAdoption({
    message: 'Create a local review environment now?',
    options: [
      {
        value: 'worktree',
        label: 'Create local worktree',
        hint: 'Recommended',
      },
      {
        value: 'branch',
        label: 'Create local branch',
        hint: 'Keep a branch only',
      },
      {
        value: 'not_now',
        label: 'Not now',
        hint: 'Leave changes in Nimbus for later',
      },
    ],
  });

  if (p.isCancel(selection) || selection === 'not_now') {
    p.log.message(`You can adopt later with: nimbus review session adopt ${readySession.id}`);
    return null;
  }

  return materializeReviewSessionForAdoption(readySession.id, {
    mode: selection as ReviewSessionMaterializeMode,
  });
}
