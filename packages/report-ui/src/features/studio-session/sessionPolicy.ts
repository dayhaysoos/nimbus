import type { ReviewPolicyDraft } from '../../types';

export interface EditablePolicyDraft {
  goal: string;
  prohibitions: string;
  constraints: string;
}

export function createEditablePolicyDraft(policy: ReviewPolicyDraft | undefined): EditablePolicyDraft {
  return {
    goal: policy?.goal ?? '',
    prohibitions: (policy?.prohibitions ?? []).join('\n'),
    constraints: (policy?.constraints ?? []).join('\n'),
  };
}

export function normalizeEditablePolicyDraft(policy: EditablePolicyDraft): ReviewPolicyDraft {
  const normalizeLines = (input: string): string[] =>
    Array.from(
      new Set(
        input
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      )
    );

  const goal = policy.goal.trim();
  return {
    goal: goal ? goal : null,
    prohibitions: normalizeLines(policy.prohibitions),
    constraints: normalizeLines(policy.constraints),
  };
}
