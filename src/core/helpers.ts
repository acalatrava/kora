/**
 * Shared utility functions used across backend, channels, and frontend builds.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function cronToHuman(expr: string): string {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const pad = (s: string) => s.padStart(2, '0');
  try {
    if (dom === '*' && mon === '*' && dow === '*') {
      if (hour === '*' && min.startsWith('*/')) return `Every ${min.slice(2)} min`;
      if (hour === '*') return `Every hour at :${pad(min)}`;
      return `Daily at ${pad(hour)}:${pad(min)}`;
    }
    if (dom === '*' && mon === '*' && dow !== '*') {
      const names = dow.split(',').map(d => DAY_NAMES[parseInt(d, 10)] || d).join(', ');
      return `${names} at ${pad(hour)}:${pad(min)}`;
    }
    if (dom !== '*' && mon === '*') return `Day ${dom} of month at ${pad(hour)}:${pad(min)}`;
    return expr;
  } catch { return expr; }
}
