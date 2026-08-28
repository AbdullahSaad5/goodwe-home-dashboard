import type { EventItem } from './types';

export interface EventFact {
  label: string;
  value: string;
}

export interface EventPresentation {
  title: string;
  typeLabel: string;
  summary: string;
  guidance: string | null;
  facts: EventFact[];
}

const faultMeanings: Record<string, string> = {
  'Utility Loss': 'The utility grid was unavailable.',
  'Vac Failure': 'Grid voltage was outside the inverter’s operating range.',
  'Fac Failure': 'Grid frequency was outside the inverter’s operating range.',
  'Isolation Failure': 'The inverter detected an insulation-resistance problem on the PV side.',
  'Relay Check Failure': 'The inverter could not verify its grid-isolation relay.',
  'Over Temperature': 'The inverter temperature exceeded its operating range.',
};

function detailString(event: EventItem, key: string): string | null {
  const value = event.details[key];
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function detailNumber(event: EventItem, key: string): number | null {
  const value = event.details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Event';
}

function formatDetail(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function address(event: EventItem, hostKey = 'host'): string | null {
  const host = detailString(event, hostKey);
  const port = detailNumber(event, 'port');
  if (!host) return null;
  return port == null ? host : `${host}:${port}`;
}

function facts(items: Array<EventFact | null>): EventFact[] {
  return items.filter((item): item is EventFact => item !== null);
}

function systemHealthPresentation(event: EventItem): EventPresentation {
  const errors = (detailString(event, 'errors') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const batteryWarning = detailString(event, 'battery_warning');
  const batteryError = detailString(event, 'battery_error');
  const errorCode = detailNumber(event, 'error_code');
  const warningCode = detailNumber(event, 'warning_code');
  const knownMeanings = errors.map(
    (error) => faultMeanings[error] ?? `The inverter reported “${error}”.`,
  );
  if (batteryWarning) knownMeanings.push(`Battery warning: ${batteryWarning}.`);
  if (batteryError) knownMeanings.push(`Battery error: ${batteryError}.`);
  const gridFault = errors.some((error) =>
    ['Utility Loss', 'Vac Failure', 'Fac Failure'].includes(error),
  );

  return {
    title: gridFault
      ? 'Grid supply fault reported'
      : event.severity === 'warning'
        ? 'Inverter warning reported'
        : 'Inverter fault reported',
    typeLabel: 'Inverter health',
    summary:
      knownMeanings.join(' ') ||
      'The inverter set a warning or error register without a readable fault description.',
    guidance: gridFault
      ? 'Normal grid-connected operation may be interrupted until voltage and frequency recover.'
      : 'Review the inverter and battery details. If the condition persists, check the equipment.',
    facts: facts([
      errorCode && errorCode !== 0 ? { label: 'Error code', value: String(errorCode) } : null,
      warningCode && warningCode !== 0
        ? { label: 'Warning code', value: String(warningCode) }
        : null,
      errors.length ? { label: 'Reported faults', value: errors.join(' · ') } : null,
    ]),
  };
}

function fallbackPresentation(event: EventItem): EventPresentation {
  const eventFacts = Object.entries(event.details).flatMap(([key, value]) => {
    const formatted = formatDetail(value);
    return formatted ? [{ label: humanize(key), value: formatted }] : [];
  });
  return {
    title: event.message || humanize(event.event_type),
    typeLabel: humanize(event.event_type),
    summary: event.message || 'The local collector recorded an event.',
    guidance: null,
    facts: eventFacts,
  };
}

export function describeEvent(event: EventItem): EventPresentation {
  if (event.event_type === 'system_health') return systemHealthPresentation(event);

  if (event.event_type === 'system_healthy') {
    return {
      title: 'Inverter fault cleared',
      typeLabel: 'Inverter health',
      summary: 'The inverter’s warning and error registers returned to normal.',
      guidance: 'Normal monitoring continues. No action is required unless the fault returns.',
      facts: [],
    };
  }

  if (event.event_type === 'collector_started') {
    const inverter = address(event);
    return {
      title: 'Monitoring started',
      typeLabel: 'Collector',
      summary: inverter
        ? `The local read-only collector started polling the inverter at ${inverter}.`
        : 'The local read-only collector started and is waiting to locate the inverter.',
      guidance: 'No action is required.',
      facts: inverter ? [{ label: 'Inverter', value: inverter }] : [],
    };
  }

  if (event.event_type === 'connection_restored') {
    const host = detailString(event, 'host');
    return {
      title: 'Inverter connection restored',
      typeLabel: 'Connectivity',
      summary: host
        ? `Live telemetry resumed from the inverter at ${host}.`
        : 'Live telemetry from the inverter resumed.',
      guidance:
        'Any preceding telemetry gap is collector or network downtime, not a confirmed utility outage.',
      facts: host ? [{ label: 'Inverter', value: host }] : [],
    };
  }

  if (event.event_type === 'connection_lost') {
    const failures = detailNumber(event, 'failures');
    const inverter = address(event);
    const reason = detailString(event, 'reason');
    return {
      title: 'Inverter telemetry connection lost',
      typeLabel: 'Connectivity',
      summary: failures
        ? `The collector could not reach the inverter after ${failures} consecutive attempts.`
        : 'The collector could not reach the inverter on the local network.',
      guidance:
        'The collector retries automatically. This telemetry interruption is not recorded as a utility outage.',
      facts: facts([
        inverter ? { label: 'Inverter', value: inverter } : null,
        reason ? { label: 'Reason', value: reason } : null,
      ]),
    };
  }

  if (event.event_type === 'inverter_discovered') {
    const host = detailString(event, 'discovered_host');
    return {
      title: 'Inverter discovered',
      typeLabel: 'Discovery',
      summary: host
        ? `GoodWe Home found the inverter at ${host} on the local network.`
        : 'GoodWe Home found the inverter on the local network.',
      guidance: 'The discovered address is saved for faster connection on the next start.',
      facts: host ? [{ label: 'Discovered address', value: host }] : [],
    };
  }

  if (event.event_type === 'inverter_rediscovered') {
    const previous = detailString(event, 'previous_host') ?? detailString(event, 'configured_host');
    const discovered = detailString(event, 'discovered_host');
    return {
      title: 'Inverter address updated',
      typeLabel: 'Discovery',
      summary:
        previous && discovered
          ? `The saved address ${previous} did not respond, so GoodWe Home found the inverter at ${discovered}.`
          : 'GoodWe Home rediscovered the inverter after its saved address stopped responding.',
      guidance: 'The new local address is saved automatically.',
      facts: facts([
        previous ? { label: 'Previous address', value: previous } : null,
        discovered ? { label: 'New address', value: discovered } : null,
      ]),
    };
  }

  return fallbackPresentation(event);
}
