import type { JobLocation, JobSalary } from '@clarity/shared-types';

import i18n from './i18n';

/**
 * Presentation helpers for Clarity Jobs.
 *
 * Every function renders only what the source actually stated. A missing
 * salary, location or date renders as absent — never as an estimate.
 */

export function formatSalary(salary: JobSalary | undefined): string | undefined {
  if (!salary) return undefined;
  const amounts = [salary.min, salary.max].filter((value): value is number => typeof value === 'number');
  if (amounts.length === 0) return undefined;
  const formatter = new Intl.NumberFormat(i18n.locale, {
    style: 'currency',
    currency: salary.currency,
    maximumFractionDigits: amounts.some((value) => value % 1 !== 0) ? 2 : 0,
  });
  const range = amounts.length === 2 && amounts[0] !== amounts[1]
    ? `${formatter.format(amounts[0])} – ${formatter.format(amounts[1])}`
    : formatter.format(amounts[0]);
  return `${range} / ${i18n.t(`jobs.interval.${salary.interval}`)}`;
}

export function formatLocations(locations: JobLocation[], applicantLocationRequirements: string[]): string | undefined {
  const stated = locations.map((location) => location.raw).filter(Boolean);
  if (stated.length > 0) return stated.slice(0, 3).join(' · ');
  if (applicantLocationRequirements.length > 0) return applicantLocationRequirements.slice(0, 3).join(' · ');
  return undefined;
}

export function formatPostedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const posted = new Date(value);
  if (Number.isNaN(posted.getTime())) return undefined;
  const days = Math.round((posted.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days > -1) return i18n.t('jobs.postedToday');
  const relative = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' });
  if (days > -31) return relative.format(days, 'day');
  return relative.format(Math.round(days / 30), 'month');
}
