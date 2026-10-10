import { describe, expect, it } from 'vitest';

import type { JobFeedKind } from '@clarity/shared-types';

import { parseJobFeedPage } from '../adapters.js';
import { jobFeedRequest } from '../endpoints.js';
import { jsonLdBlocks, noindex, places } from '../listing.js';
import { decodeBody } from '../poll.js';
import { JOB_FEED_PROVIDERS } from '../registry.js';

const extractedAt = '2026-10-10T00:00:00.000Z';

function parse(kind: JobFeedKind, identifier: string, body: unknown, extra: { cursor?: string; label?: string } = {}) {
  const requestUrl = jobFeedRequest(kind, identifier, extra.cursor).url;
  return parseJobFeedPage(kind, typeof body === 'string' ? body : JSON.stringify(body), { kind, identifier, requestUrl, extractedAt, ...extra });
}

function detail(kind: JobFeedKind, identifier: string, listBody: unknown, detailBody: unknown, label?: string) {
  const provider = JOB_FEED_PROVIDERS[kind];
  const [summary] = parse(kind, identifier, listBody, label ? { label } : {}).listings;
  const request = provider.detail!.request(summary, identifier)!;
  const context = { kind, identifier, requestUrl: request.url, extractedAt, ...(label ? { label } : {}) };
  return { summary, request, listing: provider.detail!.parse(JSON.stringify(detailBody), summary, context) };
}

function readPage(kind: JobFeedKind, identifier: string, html: string, url: string) {
  return JOB_FEED_PROVIDERS[kind].listingPage!.parse(html, { url }, { kind, identifier, requestUrl: url, extractedAt });
}

const posting = (fields: Record<string, unknown>) => `<html><head>
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', ...fields })}</script>
  </head><body></body></html>`;

describe('shared page helpers', () => {
  it('reads JSON-LD with raw line breaks inside strings, as browsers do', () => {
    const html = '<script type="application/ld+json">{"@type": "JobPosting", "title": "Vendedor",\n "description": "<h1>Uno</h1>\n<p>Dos</p>"}</script>';
    expect(jsonLdBlocks(html)).toEqual([{ '@type': 'JobPosting', title: 'Vendedor', description: '<h1>Uno</h1>\n<p>Dos</p>' }]);
    expect(jsonLdBlocks('<script type="application/ld+json">{not json</script>')).toEqual([]);
  });

  it('decodes a body in the charset it declares', () => {
    const latin = Buffer.from([0x4d, 0xe1, 0x73]); // "Más" in windows-1252
    expect(decodeBody(latin, 'text/html;charset=ISO-8859-1')).toBe('Más');
    expect(decodeBody(Buffer.from('Más'), 'text/html; charset=utf-8')).toBe('Más');
    expect(decodeBody(Buffer.from('Más'), undefined)).toBe('Más');
  });

  it('recognizes pages that ask not to be indexed', () => {
    expect(noindex('<meta name="robots" content="noindex, nofollow">')).toBe(true);
    expect(noindex('<meta content="none" name="ROBOTS">')).toBe(true);
    expect(noindex('<meta name="claritybot" content="noindex">')).toBe(true);
    expect(noindex('<meta name="robots" content="index, follow">')).toBe(false);
    expect(noindex('<meta name="googlebot" content="noindex">')).toBe(false);
  });

  it('treats two spellings of one city and country as one location', () => {
    expect(places([
      { raw: 'Troy, MI, US', locality: 'Troy', countryCode: 'US' },
      { raw: 'Troy, MI, United States', locality: 'Troy', countryCode: 'US' },
      { raw: 'Remote' },
    ])).toHaveLength(1);
  });
});

describe('page-reference sources', () => {
  it('walks a sitemap newest first, keeps only its own posting pages, and refuses an index', () => {
    const xml = `<urlset>
      <url><loc>https://jobs.example/vacatures/a</loc><lastmod>2026-09-01</lastmod></url>
      <url><loc>https://jobs.example/vacatures/b</loc><lastmod>2026-10-01</lastmod></url>
      <url><loc>https://jobs.example/about</loc></url>
      <url><loc>https://elsewhere.example/vacatures/c</loc></url></urlset>`;
    const result = parse('sitemap', 'https://jobs.example/sitemap.xml#/vacatures/', xml);
    expect(result.references?.map((reference) => reference.url)).toEqual(['https://jobs.example/vacatures/b', 'https://jobs.example/vacatures/a']);
    expect(result.references?.[0].lastModified?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(() => parse('sitemap', 'https://jobs.example/sitemap.xml', '<sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>')).toThrow('sitemap index');
  });

  it('pages a large sitemap 200 entries at a time', () => {
    const xml = `<urlset>${Array.from({ length: 450 }, (_, index) => `<url><loc>https://jobs.example/j/${index}</loc></url>`).join('')}</urlset>`;
    expect(parse('sitemap', 'https://jobs.example/sitemap.xml', xml).nextCursor).toBe('200');
    expect(parse('sitemap', 'https://jobs.example/sitemap.xml', xml, { cursor: '400' }).references).toHaveLength(50);
    expect(parse('sitemap', 'https://jobs.example/sitemap.xml', xml, { cursor: '400' }).nextCursor).toBeUndefined();
  });

  it('reads a posting page through its own JobPosting and keeps the page as canonical', () => {
    const page = readPage('sitemap', 'https://jobs.example/sitemap.xml', posting({
      title: 'Projectmanager', url: 'https://other.example/x', hiringOrganization: { name: 'Rijksvastgoedbedrijf' },
      baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { minValue: 4818, maxValue: 7094, unitText: 'MONTH' } },
    }), 'https://jobs.example/vacatures/b');
    expect(page).toMatchObject({
      title: 'Projectmanager', employerName: 'Rijksvastgoedbedrijf', canonicalUrl: 'https://jobs.example/vacatures/b',
      salary: { min: 4818, max: 7094, currency: 'EUR', interval: 'month' },
    });
    expect(readPage('sitemap', 'https://jobs.example/sitemap.xml', '<html></html>', 'https://jobs.example/x')).toBeUndefined();
  });

  it('pages Madgex RSS and strips its tracking parameters from posting links', () => {
    const items = Array.from({ length: 20 }, (_, index) => `<item><title>U: Role</title>
      <link>https://jobs.chronicle.com/job/${index}/role/?TrackID=10&amp;utm_source=rss&amp;utm_medium=feed</link>
      <pubDate>Fri, 09 Oct 2026 18:57:00 -0500</pubDate></item>`).join('');
    const result = parse('madgex', 'jobs.chronicle.com', `<rss><channel><opensearch:totalResults>28107</opensearch:totalResults>${items}</channel></rss>`);
    expect(result.references?.[0].url).toBe('https://jobs.chronicle.com/job/0/role/');
    expect(result.nextCursor).toBe('2');
  });

  it('reads an RSS feed\'s items as pages to read', () => {
    const result = parse('rss_jsonld', 'https://djinni.co/jobs/rss/', `<rss><channel>
      <item><title>Sr PM</title><link>https://djinni.co/jobs/852629-sr-product-manager/?utm_source=rss</link><pubDate>Fri, 09 Oct 2026 10:00:00 +0000</pubDate></item>
      </channel></rss>`);
    expect(result.references).toEqual([{ url: 'https://djinni.co/jobs/852629-sr-product-manager/', lastModified: new Date('2026-10-09T10:00:00.000Z') }]);
  });
});

describe('enterprise ATS providers', () => {
  it('reads Oracle requisitions and completes them from their detail', () => {
    const list = { items: [{ TotalJobsCount: 7360, requisitionList: [{
      Id: '210594721', Title: 'Private Client Advisor', PostedDate: '2026-10-09', PrimaryLocation: 'Denver, CO, United States',
      PrimaryLocationCountry: 'US', JobFamily: 'Advisors', JobSchedule: 'Full time', ShortDescriptionStr: 'Advise clients.',
    }] }] };
    const page = parse('oracle', 'jpmc.fa.oraclecloud.com/CX_1001', list, { label: 'JPMorgan Chase' });
    expect(page.listings[0]).toMatchObject({
      employerName: 'JPMorgan Chase', employmentTypes: ['full_time'], occupationalCategory: 'Advisors', identifier: '210594721',
      canonicalUrl: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210594721',
    });
    expect(page.nextCursor).toBeUndefined();
    const { request, listing } = detail('oracle', 'jpmc.fa.oraclecloud.com/CX_1001', list, { items: [{
      ExternalDescriptionStr: '<p>Full role</p>', ExternalQualificationsStr: '<ul><li>FINRA</li></ul>', BusinessUnit: 'Consumer Banking',
      ExternalPostedEndDate: '2026-11-01T00:00:00+00:00', JobSchedule: 'Full time',
      workLocation: [{ TownOrCity: 'Denver', Region2: 'CO', Country: 'US', PostalCode: '80202' }],
    }] }, 'JPMorgan Chase');
    expect(request.url).toContain('finder=ById;Id=%22210594721%22,siteNumber=CX_1001');
    expect(listing).toMatchObject({ description: 'Full role', qualifications: '- FINRA', department: 'Consumer Banking' });
    expect(listing?.validThrough?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('strips the location SuccessFactors appends to titles and finds the country among its parts', () => {
    const [job] = parse('successfactors', 'jobs.schaeffler.com', `<rss><channel><item>
      <title>SAP SD Analyst (Guadalajara, MX, 45645)</title><description><![CDATA[&lt;p&gt;Rol&lt;/p&gt;]]></description>
      <link>https://jobs.schaeffler.com/job/x/1274082401/</link><g:id>1274082401</g:id><g:employer>Schaeffler AG</g:employer>
      <g:salary>33500.00</g:salary><g:location>Guadalajara, MX, 45645</g:location></item></channel></rss>`).listings;
    expect(job).toMatchObject({ title: 'SAP SD Analyst', employerName: 'Schaeffler AG', description: 'Rol', identifier: '1274082401' });
    expect(job.locations[0].countryCode).toBe('MX');
    expect(job.salary).toBeUndefined();
  });

  it('folds Jobvite\'s per-location copies and never reads its hiring team', () => {
    const job = (location: string, parent = '') => `<job><id>${parent ? `${parent}-x` : 'oGNM'}</id>${parent ? `<parentId>${parent}</parentId>` : ''}
      <title>Account Manager</title><requisitionid>32598</requisitionid><category>Sales</category><jobtype>Full-Time</jobtype>
      <location>${location}</location><date>10/6/2026</date><description>&lt;p&gt;Sell&lt;/p&gt;</description>
      <hiring_x0020_team>A Person</hiring_x0020_team><referral_x0020_bonus>Bonus</referral_x0020_bonus></job>`;
    const { listings } = parse('jobvite', 'nutanix/qKr9VfwZ', `<result>${job('Vienna, Austria')}${job('Berlin, Germany', 'oGNM')}</result>`, { label: 'Nutanix' });
    expect(listings).toHaveLength(1);
    expect(listings[0].locations.map((location) => location.countryCode)).toEqual(['AT', 'DE']);
    expect(listings[0].publishedAt?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(JSON.stringify(listings[0])).not.toMatch(/A Person|Bonus/);
  });

  it('runs softgarden DataFeed items through the shared extractor', () => {
    const [job] = parse('softgarden', 'johanniter', { dataFeedElement: [{ item: {
      '@type': 'JobPosting', title: 'MTR (m/w/d)', url: 'https://johanniter.softgarden.io/job/1', description: '<p>Radiologie</p>',
      hiringOrganization: { name: 'Johanniter-Krankenhaus Gronau' }, datePosted: '2026-09-15',
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Gronau', addressCountry: 'Deutschland' } },
    } }] }).listings;
    expect(job).toMatchObject({ title: 'MTR (m/w/d)', employerName: 'Johanniter-Krankenhaus Gronau', canonicalUrl: 'https://johanniter.softgarden.io/job/1' });
  });

  it('reads Jibe, with a zero salary as unstated', () => {
    const [job] = parse('jibe', 'careers.mcafee.com', { totalCount: 1, jobs: [{ data: {
      slug: '1745', req_id: '1745', title: 'Flutter Engineer', description: '<p>Build</p>', responsibilities: '<ul><li>Ship</li></ul>',
      city: 'Bangalore', state: 'Karnataka', country: 'India', country_code: 'IN', tags1: ['Hybrid'], employment_type: 'FULL_TIME',
      hiring_organization: 'McAfee', salary_min_value: 0, salary_max_value: 0, posted_date: '2026-10-09T07:44:00+0000',
      posting_expiry_date: '2026-12-29T18:30:00+0000', apply_url: 'https://global-mcafee.icims.com/jobs/1745/login',
    } }] }).listings;
    expect(job).toMatchObject({ workplaceType: 'hybrid', employmentTypes: ['full_time'], responsibilities: '- Ship', canonicalUrl: 'https://careers.mcafee.com/jobs/1745' });
    expect(job.salary).toBeUndefined();
  });
});

describe('public employment providers', () => {
  it('reads EURES vacancies by country and enriches them without reading contact people', () => {
    const list = { numberRecords: 645_000, jvs: [{
      id: 'MTgw', title: 'Schichtleiter', description: 'Wir laden dich ein.', employer: { name: "L'Osteria", website: 'http://losteria.de/' },
      locationMap: { DE: ['DEF03'] }, positionScheduleCodes: ['fulltime'], positionOfferingCode: 'directhire', creationDate: 1791523800148,
    }, { id: 'anon', title: 'Electricista', description: 'Sin empresa.', employer: null, locationMap: { ES: ['ES511'] } }] };
    const page = parse('eures', 'de', list);
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]).toMatchObject({ employerName: "L'Osteria", employmentTypes: ['full_time'] });
    expect(page.listings[0].locations).toEqual([{ raw: 'Germany', countryCode: 'DE' }]);
    const { listing } = detail('eures', 'de', list, {
      preferredLanguage: 'de',
      jvProfiles: { de: {
        description: 'Wir laden dich ein, voll.', locations: [{ countryCode: 'de', cityName: 'Lübeck', postalCode: '23552' }],
        offeredRemunerationPackage: { salaries: [{ minimumSalary: 3200, maximumSalary: 3800, currencyCode: 'EUR', payingIntervalCode: 'month' }] },
        requiredYearsOfExperience: 2, lastApplicationDate: 1799280000000, remoteWorkAllowed: false,
        personContacts: [{ givenName: 'Piotr', familyName: 'Brelik', phones: ['606 283 583'] }],
        applicationInstructions: ['Piotr BRELIK, tel.: 606 283 583'],
      } },
    });
    expect(listing).toMatchObject({ salary: { min: 3200, max: 3800, currency: 'EUR', interval: 'month' }, experienceRequirements: '2+ years' });
    expect(listing?.locations[0]).toMatchObject({ locality: 'Lübeck', countryCode: 'DE', postalCode: '23552' });
    expect(JSON.stringify(listing)).not.toMatch(/Piotr|Brelik|606 283/i);
  });

  it('reads Feina Activa without assuming a salary period or a country', () => {
    const [job] = parse('feinaactiva', 'feinaactiva', `<ofertes><feinaactiva><ad><id>FA1</id><url>https://feinaactiva.gencat.cat/search/offers/detail/FA1</url>
      <title>CAMBRER/A</title><content>Servir.</content><company>Empresa de restauració</company><experience>Experiència 0 anys.</experience>
      <requirements>anglès</requirements><contract>Contracte laboral temporal (2 mesos)</contract><workingHours>Jornada completa</workingHours>
      <date>26/08/2026</date><salaryMin>1416</salaryMin><salaryMax>1550</salaryMax><city>CALELLA</city><region>BARCELONA</region>
      <postcode>08370</postcode><status>PUBLISHED</status></ad></feinaactiva></ofertes>`).listings;
    expect(job).toMatchObject({ employmentTypes: ['full_time', 'temporary'], identifier: 'FA1' });
    expect(job.salary).toBeUndefined();
    expect(job.locations[0].countryCode).toBeUndefined();
    expect(job.publishedAt?.toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });

  it('reads Karriere.NRW details without contact people or pay grades as salary', () => {
    const list = { pages: 101, items: [{ uuid: 'u1', title: 'Justitiar', authority: 'Stadt Gelsenkirchen', location: 'Gelsenkirchen', published: '2026-09-23', deadline: '2026-10-14' }] };
    const { listing } = detail('karrierenrw', 'karrierenrw', list, {
      titel_der_stelle: 'Justitiar (w/m/d)', behoerde: 'Stadt Gelsenkirchen', stellenbeschreibung: '<p>Recht</p>',
      address_display: 'Ebertstraße 11, 45879 Gelsenkirchen', ort: 'Gelsenkirchen', arbeitszeit_display: ['Vollzeit mit Teilzeitmöglichkeit'],
      befristung_display: 'Befristet (mit Sachgrund)', besoldung_entgelt: ['A 14', 'TVöD 14'], taetigkeitsfeld_display: ['Recht'],
      ansprechpartner: [{ name: 'Frau Bokies', e_mail: 'bewerbung@gelsenkirchen.de', telefon: '0209/169 - 2215' }],
      dienststelle: { webseite: 'https://www.gelsenkirchen.de/karriere', plz: '45879' },
    });
    expect(listing).toMatchObject({ employmentTypes: ['full_time', 'part_time', 'temporary'], occupationalCategory: 'Recht', description: 'Recht' });
    expect(listing?.salary).toBeUndefined();
    expect(JSON.stringify(listing)).not.toMatch(/Bokies|bewerbung@|2215/);
  });

  it('reads jobs.admin.ch sections and never its contact block', () => {
    const [job] = parse('jobsadminch', 'jobsadminch', { total: 1, jobs: [{
      id: '10221755', title: 'Koch EFZ', attributes: { verwaltungseinheit_1083398: ['Bundesamt für Sport BASPO'], taetigkeitsbereich: ['Gastronomie'] },
      szas: {
        sza_title: 'Lernende/-r Koch/Köchin EFZ', 'sza_pensum.min': '80', 'sza_pensum.max': '100', sza_tasks: '<ul><li>Kochen</li></ul>',
        sza_requirements: '<ul><li>Schule</li></ul>', sza_benefits: '<ul><li>Sport</li></ul>', 'sza_location.city': 'Magglingen, Schweiz',
        sza_contact: '<b>Céline Bärlocher</b><br/>+41 58 46 61393', sza_apply_link: 'https://career74.sapsf.eu/career?x=1',
      },
      links: { directlink: 'https://jobs.admin.ch/offene-stellen/koch/6e1e' }, start_date: '2026-10-08T22:00:00Z', end_date: '2026-11-08T22:59:59Z',
    }] }).listings;
    expect(job).toMatchObject({
      employerName: 'Bundesamt für Sport BASPO', employmentTypes: ['full_time', 'part_time'],
      description: '- Kochen', qualifications: '- Schule', benefits: '- Sport',
    });
    expect(JSON.stringify(job)).not.toMatch(/Bärlocher|61393/);
  });

  it('reads Get on Board countries as locations for on-site roles and as applicant regions for remote ones', () => {
    const job = (modality: string) => ({
      id: `j-${modality}`, attributes: { title: 'Dev', description: '<p>x</p>', remote_modality: modality, countries: ['Chile'], published_at: 1791590800,
        company: { data: { attributes: { name: 'BICE VIDA' } } } },
      links: { public_url: `https://www.getonbrd.com/jobs/j-${modality}` },
    });
    const { listings } = parse('getonboard', 'programming', { meta: { total_pages: 1 }, data: [job('hybrid'), job('fully_remote')] });
    expect(listings[0]).toMatchObject({ workplaceType: 'hybrid', applicantLocationRequirements: [] });
    expect(listings[0].locations[0]).toMatchObject({ countryCode: 'CL' });
    expect(listings[1]).toMatchObject({ workplaceType: 'remote', applicantLocationRequirements: ['Chile'], locations: [] });
  });
});

describe('aggregator XML feeds', () => {
  it('reads the Indeed XML format, a state in <country> as a region, and never contact fields', () => {
    const xml = `<?xml version="1.0"?><source><publisher>AI Dev Jobs</publisher>
      <job><title><![CDATA[Sr Data Scientist]]></title><date><![CDATA[Mon, 14 Sep 2026 05:15:34 GMT]]></date>
      <referencenumber><![CDATA[2455732f]]></referencenumber>
      <url><![CDATA[https://aidevboard.com/job/sr-data-scientist?utm_source=aggregator&utm_medium=feed]]></url>
      <company><![CDATA[Dataiku]]></company><city><![CDATA[New York]]></city><country><![CDATA[NY]]></country>
      <description><![CDATA[<p>Build models</p>]]></description><salary><![CDATA[$210k–$220k per year]]></salary>
      <jobtype><![CDATA[fulltime]]></jobtype><experience><![CDATA[Senior]]></experience>
      <email><![CDATA[recruiter@dataiku.example]]></email><expirationdate>2026-10-14</expirationdate></job>
      <job><title>Platform Engineer</title><url>https://board.example/j/2</url><company>Acme</company>
      <city>Berlin</city><state>Berlin</state><country>DE</country><remotetype>Hybrid remote</remotetype>
      <salary>60.000 - 75.000 € per year</salary><jobtype>Full-Time, Permanent</jobtype></job></source>`;
    const { listings } = parse('indeed_xml', 'https://aidevboard.com/feed/indeed.xml', xml);
    expect(listings[0]).toMatchObject({
      title: 'Sr Data Scientist', employerName: 'Dataiku', canonicalUrl: 'https://aidevboard.com/job/sr-data-scientist',
      employmentTypes: ['full_time'], seniority: 'senior', identifier: '2455732f', description: 'Build models',
    });
    expect(listings[0].locations[0]).toMatchObject({ locality: 'New York', region: 'NY' });
    expect(listings[0].locations[0].countryCode).toBeUndefined();
    expect(listings[0].salary).toBeUndefined();
    expect(JSON.stringify(listings[0])).not.toContain('recruiter@');
    expect(listings[1]).toMatchObject({ workplaceType: 'hybrid', employmentTypes: ['full_time'], salary: { min: 60_000, max: 75_000, currency: 'EUR', interval: 'year' } });
    expect(listings[1].locations[0].countryCode).toBe('DE');
  });

  it('reads Workable\'s global feed variant and skips jobs hidden from aggregators', () => {
    const xml = `<source><publisher>Workable</publisher>
      <job><title>\n <![CDATA[System Engineer]]>\n </title><date><![CDATA[Wed, 28 Jul 2021 10:24:17 UTC]]></date>
      <referencenumber><![CDATA[F44ED9E40A]]></referencenumber><url><![CDATA[https://apply.workable.com/j/F44ED9E40A]]></url>
      <company><![CDATA[Tech Firefly]]></company><city>Hyderabad</city><state>Telangana</state><country>IN</country>
      <remote><![CDATA[true]]></remote><website><![CDATA[https://techfirefly.com]]></website><cpc>0.42</cpc></job>
      <job><title>Hidden</title><url>https://apply.workable.com/j/HIDDEN</url><company>Acme</company>
      <hide_from_indeed_search>CONFIDENTIAL_JOB</hide_from_indeed_search></job></source>`;
    const { listings } = parse('indeed_xml', 'https://www.workable.com/boards/workable.xml', xml);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ title: 'System Engineer', workplaceType: 'remote', employerUrl: 'https://techfirefly.com/' });
    expect(listings[0].locations[0]).toMatchObject({ locality: 'Hyderabad', region: 'Telangana', countryCode: 'IN' });
    expect(listings[0].publishedAt?.toISOString()).toBe('2021-07-28T10:24:17.000Z');
    expect(JSON.stringify(listings[0])).not.toContain('0.42');
  });
});

describe('regional ATS providers', () => {
  it('reads d.vinci publications once per job opening, with the opening\'s locations and never the responsible user', () => {
    const publication = (id: number, language: string) => ({
      id, language, position: 'Storemanagerin', jobPublicationURL: `https://mey.dvinci-hr.com/${language}/jobs/${id}/x`,
      applicationFormURL: `https://mey.dvinci-hr.com/${language}/jobs/${id}/apply`, tasks: '<ul><li>Verkaufen</li></ul>', profile: '<p>Freude</p>', weOffer: '<p>Rabatt</p>',
      jobOpening: {
        id: 50576, company: { name: 'Mey Handels GmbH' }, orgUnit: { name: 'Retail' }, categories: [{ name: 'Verkauf' }],
        workingTimes: [{ internalName: 'FULL_TIME' }], contractPeriod: { internalName: 'UNLIMITED' },
        locations: [{ name: 'Neumünster', country: { name: 'Germany', isoA2: 'DE' }, address: { country: { isoA2: 'DE' } } }],
        responsibleUser: { firstName: 'Ramona', lastName: 'Göktas', email: 'ramona@mey.example', telephone: '+49 7431 706-0' },
      },
    });
    const { listings } = parse('dvinci', 'mey', [publication(50584, 'de'), publication(50585, 'en')]);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ employerName: 'Mey Handels GmbH', employmentTypes: ['full_time'], department: 'Retail', qualifications: 'Freude', benefits: 'Rabatt' });
    expect(listings[0].locations[0]).toMatchObject({ locality: 'Neumünster', countryCode: 'DE' });
    expect(JSON.stringify(listings[0])).not.toMatch(/Ramona|Göktas|ramona@|706-0/);
  });

  it('reads JobScore pay in cents and its tracking-free listing URL', () => {
    const [job] = parse('jobscore', 'allogene', { company_name: 'Allogene', jobs: [{
      id: 'cgP6', title: 'Medical Director', detail_url: 'https://careers.jobscore.com/careers/allogene/jobs/md-cgP6?ref=rss&sid=68',
      city: 'South San Francisco', state: 'CA', country: 'US', remote: 'Yes | Can telecommute', job_type: 'Full Time',
      experience_level: 'Executive (SVP, VP, Director, etc.)', public_salary_minimum: 25500000, public_salary_maximum: 33500000,
      public_compensation_interval: 'per year', currency_code: 'USD', hiring_team: [{ name: 'A Recruiter' }],
    }] }).listings;
    expect(job).toMatchObject({
      canonicalUrl: 'https://careers.jobscore.com/careers/allogene/jobs/md-cgP6', workplaceType: 'remote', seniority: 'executive',
      salary: { min: 255_000, max: 335_000, currency: 'USD', interval: 'year' },
    });
    expect(JSON.stringify(job)).not.toContain('A Recruiter');
  });

  it('reads HR Manager\'s Microsoft-style dates', () => {
    const [job] = parse('hrmanager', 'regionh', { CustomerName: 'Region Hovedstaden', Items: [{
      Id: 270919, Name: 'Sygeplejerske', CustomerName: 'Region Hovedstaden', AdvertisementUrlSecure: 'https://candidate.hr-manager.net/ApplicationInit.aspx?cid=342&ProjectId=270919',
      Published: '/Date(1790841863000+0200)/', ApplicationDue: '/Date(1792015199000+0200)/', Advertisements: [{ Content: '<p>Kirurgi</p>' }],
      DepartmentTree: { Address: 'Kongens Vænge 2', City: 'Hillerød', Country: 'Danmark' }, ProjectLeader: 'A Person',
    }] }).listings;
    expect(job.publishedAt?.toISOString()).toBe(new Date(1790841863000).toISOString());
    expect(job.validThrough?.toISOString()).toBe(new Date(1792015199000).toISOString());
    expect(job.description).toBe('Kirurgi');
    expect(JSON.stringify(job)).not.toContain('A Person');
  });

  it('reads a board directory as boards to register, never as listings', () => {
    const page = parse('directory', 'https://careers.jobscore.com/sitemaps/careers.xml.gz', `<urlset>
      <url><loc>https://careers.jobscore.com/careers/hexagon</loc></url>
      <url><loc>https://careers.jobscore.com/careers/hexagon/jobs/bdm-dCkN</loc></url>
      <url><loc>https://careers.jobscore.com/careers/allogene</loc></url>
      <url><loc>https://www.jobscore.com/pricing</loc></url></urlset>`);
    expect(page.listings).toEqual([]);
    expect(page.boardUrls).toHaveLength(4);
  });

  it('reads WP Job Manager listings from the API when they name the employer and from the page when they do not', () => {
    const result = parse('wp_job_manager', 'https://workew.com', [
      { id: 1, link: 'https://workew.com/job/ml-quora/', date_gmt: '2026-10-01T10:00:00', title: { rendered: 'ML Engineer' }, content: { rendered: '<p>Ads</p>' },
        meta: { _company_name: 'Quora', _application: 'https://jobs.ashbyhq.com/quora/1/application', _job_location: 'Remote', _remote_position: '1' } },
      { id: 2, link: 'https://laura.fi/avoimet-tyopaikat/x/2/', modified_gmt: '2026-10-09T21:14:45', title: { rendered: 'Sijainen' }, meta: {} },
    ]);
    expect(result.listings[0]).toMatchObject({ employerName: 'Quora', workplaceType: 'remote', applyUrl: 'https://jobs.ashbyhq.com/quora/1/application' });
    expect(result.listings[0].publishedAt?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(result.references).toEqual([{ url: 'https://laura.fi/avoimet-tyopaikat/x/2/', lastModified: new Date('2026-10-09T21:14:45.000Z') }]);
  });
});

describe('national board sources and robustness', () => {
  it('reads the Jobbnorge API with Norwegian scope and duration', () => {
    const [job] = parse('jobbnorge', 'jobbnorge', { jobs: [{
      id: 307978, title: 'Ekspedisjonssjef', employer: 'Kunnskapsdepartementet', summary: 'Lederstilling.',
      link: 'https://www.jobbnorge.no/ledige-stillinger/stilling/307978', jobScope: 'Heltid', jobDuration: 'Vikariat',
      locations: [{ area: 'Oslo', county: 'Oslo', zipCode: '0153', isDomestic: true }], publicationDate: '21.09.2026', deadline: '11.10.2026',
    }] }).listings;
    expect(job).toMatchObject({ employerName: 'Kunnskapsdepartementet', employmentTypes: ['full_time', 'temporary'] });
    expect(job.locations[0]).toMatchObject({ locality: 'Oslo', countryCode: 'NO', postalCode: '0153' });
    expect(job.publishedAt?.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(job.validThrough?.toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });

  it('keeps sitemap postings on the same registrable domain as the sitemap, even across a CDN host', () => {
    const page = parse('sitemap', 'https://statics.free-work.com/sitemap.xml#/fr/', `<urlset>
      <url><loc>https://www.free-work.com/fr/job/a</loc></url>
      <url><loc>https://www.free-work.com/en/job/b</loc></url>
      <url><loc>https://evil.example/fr/job/c</loc></url></urlset>`);
    expect(page.references?.map((r) => r.url)).toEqual(['https://www.free-work.com/fr/job/a']);
  });

  it('reads a JobPosting block an author entity-escaped whole', () => {
    const encoded = '&quot;@context&quot;:&quot;https://schema.org&quot;,&quot;@type&quot;:&quot;JobPosting&quot;,&quot;title&quot;:&quot;Dev&quot;,&quot;hiringOrganization&quot;:&#123;&quot;name&quot;:&quot;Acme&quot;&#125;';
    const html = `<script type="application/ld+json">{${encoded}}</script>`;
    const page = readPage('sitemap', 'https://x.example/sitemap.xml', html, 'https://x.example/job/1');
    expect(page).toMatchObject({ title: 'Dev', employerName: 'Acme', canonicalUrl: 'https://x.example/job/1' });
  });
});
