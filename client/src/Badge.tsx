export function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Not started';
  return status.replaceAll('_', ' ').toLowerCase();
}
export function Badge({ status }: { status: string | null | undefined }) {
  return <span className={'badge status-' + (status || 'NONE')}>{statusLabel(status)}</span>;
}
