import type { ReviewStatus } from '../../types';
import { Badge } from './badge';
import { cn } from '../../lib/utils';

interface StatusPillProps {
  status: ReviewStatus;
}

function statusLabel(status: ReviewStatus): string {
  return status.replace(/_/g, ' ');
}

function statusClass(status: ReviewStatus): string {
  if (status === 'succeeded') {
    return 'border-emerald-200 bg-emerald-100 text-emerald-900';
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'border-rose-200 bg-rose-100 text-rose-900';
  }
  return 'border-blue-200 bg-blue-100 text-blue-900';
}

export function StatusPill({ status }: StatusPillProps): JSX.Element {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]',
        statusClass(status)
      )}
    >
      {statusLabel(status)}
    </Badge>
  );
}
