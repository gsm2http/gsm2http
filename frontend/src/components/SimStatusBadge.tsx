import type { SimStatus } from '../api/types';

const colors: Record<SimStatus, string> = {
  READY: 'bg-green-100 text-green-800',
  'SIM PIN': 'bg-amber-100 text-amber-800',
  'SIM PUK': 'bg-red-100 text-red-800',
  'NO SIM': 'bg-red-100 text-red-800',
  ERROR: 'bg-red-100 text-red-800',
  UNKNOWN: 'bg-red-100 text-red-800',
};

interface Props {
  status: SimStatus;
  className: string;
}

export function SimStatusBadge({ status, className }: Props) {
  return <span className={`${className} ${colors[status]}`}>{status}</span>;
}
