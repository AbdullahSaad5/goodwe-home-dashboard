export function shouldBypassDashboardAuth({
  dev,
  mode,
}: {
  dev: boolean;
  mode: string;
}): boolean {
  return dev || mode === 'lan';
}
