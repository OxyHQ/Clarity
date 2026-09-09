/**
 * Normalization vocabulary for Clarity Jobs.
 *
 * Every mapping here turns an explicit source value into a Clarity value. None
 * of it guesses: a value that does not map stays `undefined` and the field is
 * simply absent from the projection.
 */
import { createHash } from 'node:crypto';

import type {
  JobEmploymentType,
  JobSalaryInterval,
  JobWorkplaceType,
} from '@clarity/shared-types';

export const JOB_WORKPLACE_TYPES = ['remote', 'hybrid', 'onsite'] as const satisfies readonly JobWorkplaceType[];
export const JOB_EMPLOYMENT_TYPES = [
  'full_time', 'part_time', 'contract', 'temporary', 'internship', 'volunteer', 'per_diem', 'other',
] as const satisfies readonly JobEmploymentType[];
export const JOB_SALARY_INTERVALS = ['hour', 'day', 'week', 'month', 'year'] as const satisfies readonly JobSalaryInterval[];
export const JOB_LIFECYCLE_STATUSES = ['active', 'expired', 'closed', 'removed', 'stale'] as const;
export const JOB_SOURCE_TYPES = ['web', 'verified_site', 'first_party'] as const;

/** `schema.org` employment codes, plus the unambiguous spellings sites use. */
const EMPLOYMENT_TYPE_BY_TOKEN: Readonly<Record<string, JobEmploymentType>> = Object.freeze({
  fulltime: 'full_time',
  full: 'full_time',
  parttime: 'part_time',
  part: 'part_time',
  contractor: 'contract',
  contract: 'contract',
  freelance: 'contract',
  temporary: 'temporary',
  temp: 'temporary',
  seasonal: 'temporary',
  intern: 'internship',
  internship: 'internship',
  apprenticeship: 'internship',
  volunteer: 'volunteer',
  perdiem: 'per_diem',
  other: 'other',
});

const SALARY_INTERVAL_BY_TOKEN: Readonly<Record<string, JobSalaryInterval>> = Object.freeze({
  hour: 'hour', hourly: 'hour', h: 'hour',
  day: 'day', daily: 'day', d: 'day',
  week: 'week', weekly: 'week', w: 'week',
  month: 'month', monthly: 'month', m: 'month',
  year: 'year', yearly: 'year', annual: 'year', annually: 'year', y: 'year',
});

/**
 * Fixed working-time factors used ONLY to compare salaries expressed in
 * different intervals inside a filter. The source interval and amount stay
 * authoritative for display; Clarity never converts currencies.
 */
export const SALARY_ANNUALIZATION_FACTORS: Readonly<Record<JobSalaryInterval, number>> = Object.freeze({
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
});

/**
 * ISO 3166-1 alpha-2 codes with the English (and common Spanish) names Clarity
 * accepts in a location filter or a `schema.org` address.
 */
const COUNTRY_TABLE = `
AD:Andorra|AE:United Arab Emirates,UAE|AF:Afghanistan|AL:Albania|AM:Armenia|AO:Angola|AR:Argentina|AT:Austria|AU:Australia|AZ:Azerbaijan
BA:Bosnia and Herzegovina|BB:Barbados|BD:Bangladesh|BE:Belgium,Belgica|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BN:Brunei
BO:Bolivia|BR:Brazil,Brasil|BS:Bahamas|BT:Bhutan|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CD:Democratic Republic of the Congo|CF:Central African Republic
CG:Republic of the Congo|CH:Switzerland,Suiza|CI:Ivory Coast,Cote d Ivoire|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CR:Costa Rica|CU:Cuba|CV:Cabo Verde
CY:Cyprus|CZ:Czechia,Czech Republic|DE:Germany,Deutschland,Alemania|DJ:Djibouti|DK:Denmark,Dinamarca|DO:Dominican Republic|DZ:Algeria|EC:Ecuador|EE:Estonia|EG:Egypt
ER:Eritrea|ES:Spain,Espana|ET:Ethiopia|FI:Finland|FJ:Fiji|FM:Micronesia|FO:Faroe Islands|FR:France,Francia|GA:Gabon|GB:United Kingdom,UK,Great Britain,England,Scotland,Wales,Reino Unido
GE:Georgia|GH:Ghana|GI:Gibraltar|GM:Gambia|GN:Guinea|GQ:Equatorial Guinea|GR:Greece,Grecia|GT:Guatemala|GW:Guinea-Bissau|GY:Guyana
HK:Hong Kong|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|ID:Indonesia|IE:Ireland,Irlanda|IL:Israel|IN:India|IQ:Iraq
IR:Iran|IS:Iceland|IT:Italy,Italia|JM:Jamaica|JO:Jordan|JP:Japan,Japon|KE:Kenya|KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati
KM:Comoros|KP:North Korea|KR:South Korea,Korea|KW:Kuwait|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LI:Liechtenstein|LK:Sri Lanka|LR:Liberia
LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MG:Madagascar
MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar|MN:Mongolia|MO:Macao|MR:Mauritania|MT:Malta|MU:Mauritius|MV:Maldives
MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NE:Niger|NG:Nigeria|NI:Nicaragua|NL:Netherlands,Holland,Paises Bajos|NO:Norway,Noruega
NP:Nepal|NR:Nauru|NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|PG:Papua New Guinea|PH:Philippines|PK:Pakistan|PL:Poland,Polonia
PR:Puerto Rico|PS:Palestine|PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda
SA:Saudi Arabia|SB:Solomon Islands|SC:Seychelles|SD:Sudan|SE:Sweden,Suecia|SG:Singapore|SI:Slovenia|SK:Slovakia|SL:Sierra Leone|SM:San Marino
SN:Senegal|SO:Somalia|SR:Suriname|SS:South Sudan|SV:El Salvador|SY:Syria|SZ:Eswatini|TD:Chad|TG:Togo|TH:Thailand
TJ:Tajikistan|TL:Timor-Leste|TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Turkey,Turkiye,Turquia|TT:Trinidad and Tobago|TV:Tuvalu|TW:Taiwan|TZ:Tanzania
UA:Ukraine|UG:Uganda|US:United States,United States of America,USA,US,Estados Unidos|UY:Uruguay|UZ:Uzbekistan|VA:Vatican City|VE:Venezuela|VN:Vietnam|VU:Vanuatu|WS:Samoa
YE:Yemen|ZA:South Africa|ZM:Zambia|ZW:Zimbabwe|XK:Kosovo
`;

const COUNTRY_CODE_BY_NAME = new Map<string, string>();
export const COUNTRY_NAME_BY_CODE = new Map<string, string>();
for (const entry of COUNTRY_TABLE.split(/[\n|]/)) {
  const trimmed = entry.trim();
  if (!trimmed) continue;
  const [code, names] = trimmed.split(':');
  const [primary, ...aliases] = names.split(',');
  COUNTRY_NAME_BY_CODE.set(code, primary);
  COUNTRY_CODE_BY_NAME.set(code.toLowerCase(), code);
  for (const name of [primary, ...aliases]) COUNTRY_CODE_BY_NAME.set(foldCase(name), code);
}

/**
 * Macro-regions accepted in a location filter. A region is only ever expanded
 * into the country codes below — Clarity does not infer that an unlisted
 * country belongs to a region.
 */
export const JOB_REGIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  europe: ['AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SK', 'SM', 'TR', 'UA', 'VA', 'XK'],
  european_union: ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'],
  north_america: ['BS', 'BB', 'BZ', 'CA', 'CR', 'CU', 'DO', 'GT', 'HN', 'HT', 'JM', 'MX', 'NI', 'PA', 'PR', 'SV', 'TT', 'US'],
  south_america: ['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE'],
  latin_america: ['AR', 'BO', 'BR', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'GT', 'HN', 'MX', 'NI', 'PA', 'PE', 'PY', 'SV', 'UY', 'VE'],
  africa: ['AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV', 'DJ', 'DZ', 'EG', 'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM', 'LR', 'LS', 'LY', 'MA', 'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RW', 'SC', 'SD', 'SL', 'SN', 'SO', 'SS', 'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW'],
  asia: ['AF', 'AM', 'AZ', 'BD', 'BH', 'BN', 'BT', 'CN', 'CY', 'GE', 'HK', 'ID', 'IL', 'IN', 'IQ', 'IR', 'JO', 'JP', 'KG', 'KH', 'KP', 'KR', 'KW', 'KZ', 'LA', 'LB', 'LK', 'MM', 'MN', 'MO', 'MV', 'MY', 'NP', 'OM', 'PH', 'PK', 'PS', 'QA', 'SA', 'SG', 'SY', 'TH', 'TJ', 'TL', 'TM', 'TR', 'TW', 'UZ', 'VN', 'YE', 'AE'],
  middle_east: ['AE', 'BH', 'CY', 'EG', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'TR', 'YE'],
  oceania: ['AU', 'FJ', 'FM', 'KI', 'MH', 'NR', 'NZ', 'PG', 'PW', 'SB', 'TO', 'TV', 'VU', 'WS'],
});

const REGION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  europe: 'europe', european: 'europe', eu: 'european_union', 'european union': 'european_union', ue: 'european_union',
  'north america': 'north_america', northamerica: 'north_america',
  'south america': 'south_america', southamerica: 'south_america', sudamerica: 'south_america',
  'latin america': 'latin_america', latam: 'latin_america', latinoamerica: 'latin_america',
  africa: 'africa', asia: 'asia', apac: 'asia',
  'middle east': 'middle_east', middleeast: 'middle_east',
  oceania: 'oceania',
});

export function foldCase(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeEmploymentType(value: string): JobEmploymentType | undefined {
  const token = foldCase(value).replace(/[^a-z]/g, '');
  return EMPLOYMENT_TYPE_BY_TOKEN[token];
}

export function normalizeSalaryInterval(value: string): JobSalaryInterval | undefined {
  const token = foldCase(value).replace(/[^a-z]/g, '');
  return SALARY_INTERVAL_BY_TOKEN[token];
}

/** ISO 4217 alpha codes only; anything else is dropped rather than guessed. */
export function normalizeCurrency(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/** Resolves an explicit country code or recognized country name to alpha-2. */
export function normalizeCountry(value: string): string | undefined {
  const folded = foldCase(value);
  if (!folded) return undefined;
  return COUNTRY_CODE_BY_NAME.get(folded);
}

/** Expands a macro-region name into its documented country-code list. */
export function resolveRegion(value: string): readonly string[] | undefined {
  const key = REGION_ALIASES[foldCase(value).replace(/_/g, ' ')] ?? REGION_ALIASES[foldCase(value)];
  return key ? JOB_REGIONS[key] : undefined;
}

/** Annualized amount used only for cross-interval salary filtering. */
export function annualizeSalary(amount: number, interval: JobSalaryInterval): number {
  return amount * SALARY_ANNUALIZATION_FACTORS[interval];
}

/** Case/punctuation-insensitive title used as ONE of several dedupe signals. */
export function normalizeJobTitle(title: string): string {
  return foldCase(title).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Registrable host of a URL, lowercased and without a leading `www.`. */
export function urlDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** Stable identity for an employer: its domain when known, else its name. */
export function employerKey(name: string | undefined, url: string | undefined): string | undefined {
  const domain = urlDomain(url);
  if (domain) return `domain:${domain}`;
  const folded = name ? foldCase(name).replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim() : '';
  return folded ? `name:${folded}` : undefined;
}

/**
 * Fingerprint of a listing body. Whitespace, case and punctuation are folded so
 * that a syndicated copy of the same description fingerprints identically,
 * while an edited description does not.
 */
export function descriptionFingerprint(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const normalized = foldCase(description).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length < 200) return undefined;
  return createHash('sha256').update(normalized.slice(0, 4000)).digest('hex');
}
