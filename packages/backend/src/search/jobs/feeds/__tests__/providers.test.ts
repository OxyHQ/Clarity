import { describe, expect, it } from 'vitest';

import type { JobFeedKind } from '@clarity/shared-types';

import { parseJobFeedPage } from '../adapters.js';
import { jobFeedRequest } from '../endpoints.js';
import { JOB_FEED_PROVIDERS } from '../registry.js';

const extractedAt = '2026-10-10T00:00:00.000Z';

function parse(
  kind: JobFeedKind,
  identifier: string,
  body: unknown,
  extra: { cursor?: string; label?: string } = {},
) {
  const requestUrl = jobFeedRequest(kind, identifier, extra.cursor).url;
  return parseJobFeedPage(kind, typeof body === 'string' ? body : JSON.stringify(body), {
    kind,
    identifier,
    requestUrl,
    extractedAt,
    ...extra,
  });
}

function detail(
  kind: JobFeedKind,
  identifier: string,
  listingBody: unknown,
  detailBody: unknown,
  label?: string,
) {
  const provider = JOB_FEED_PROVIDERS[kind];
  const [summary] = parse(kind, identifier, listingBody, label ? { label } : {}).listings;
  const request = provider.detail!.request(summary, identifier)!;
  return {
    request,
    listing: provider.detail!.parse(JSON.stringify(detailBody), summary, {
      kind,
      identifier,
      requestUrl: request.url,
      extractedAt,
      ...(label ? { label } : {}),
    }),
  };
}

describe('ATS providers', () => {
  it('reads Greenhouse pay ranges, workplace metadata and offices', () => {
    const { listings } = parse('greenhouse', 'anthropic', {
      jobs: [
        {
          id: 4461450008,
          title: 'Account Executive',
          company_name: 'Anthropic',
          absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008',
          location: { name: 'New York City, NY; San Francisco, CA' },
          offices: [{ name: 'New York City, NY', location: 'New York, New York, United States' }],
          departments: [{ name: 'Sales' }],
          metadata: [{ name: 'Location Type', value: 'Hybrid (Travel-Required)' }],
          pay_input_ranges: [
            {
              min_cents: 22280000,
              max_cents: 29000000,
              currency_type: 'USD',
              title: 'Annual Salary:',
            },
          ],
          first_published: '2024-12-20T13:53:38-05:00',
          application_deadline: '2026-12-01T00:00:00Z',
        },
        {
          id: 2,
          title: 'Hourly role',
          company_name: 'Anthropic',
          absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/2',
          pay_input_ranges: [
            { min_cents: 4000, max_cents: 5000, currency_type: 'USD', title: 'Compensation' },
          ],
        },
      ],
    });
    expect(listings[0]).toMatchObject({
      workplaceType: 'hybrid',
      department: 'Sales',
      salary: { min: 222_800, max: 290_000, currency: 'USD', interval: 'year' },
    });
    expect(listings[0].locations).toEqual([
      {
        raw: 'New York, New York, United States',
        countryCode: 'US',
        country: 'United States',
        locality: 'New York',
        region: 'New York',
      },
    ]);
    expect(listings[0].validThrough?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    // A pay range whose title names no interval is not a salary.
    expect(listings[1].salary).toBeUndefined();
  });

  it('reads Lever pay, stated workplace and the operator label as employer', () => {
    const { listings } = parse(
      'lever_eu',
      'olx',
      [
        {
          id: 'a',
          text: 'Account Manager',
          hostedUrl: 'https://jobs.eu.lever.co/olx/a',
          applyUrl: 'https://jobs.eu.lever.co/olx/a/apply',
          workplaceType: 'remote',
          categories: {
            location: 'Szczecin, Poland',
            commitment: 'Full-time',
            department: 'Otomoto',
          },
          salaryRange: { min: 8000, max: 11000, currency: 'PLN', interval: 'per-month-salary' },
        },
      ],
      { label: 'OLX Group' },
    );
    expect(listings[0]).toMatchObject({
      employerName: 'OLX Group',
      workplaceType: 'remote',
      employmentTypes: ['full_time'],
      department: 'Otomoto',
      applyUrl: 'https://jobs.eu.lever.co/olx/a/apply',
      salary: { min: 8000, max: 11000, currency: 'PLN', interval: 'month' },
    });
    expect(jobFeedRequest('lever_eu', 'olx').url).toBe(
      'https://api.eu.lever.co/v0/postings/olx?mode=json',
    );
  });

  it('reads Ashby compensation tiers, secondary locations and skips unlisted jobs', () => {
    const { listings } = parse('ashby', 'openai', {
      jobs: [
        {
          id: 'x',
          title: 'TPM',
          organizationName: 'OpenAI',
          jobUrl: 'https://jobs.ashbyhq.com/openai/x',
          applyUrl: 'https://jobs.ashbyhq.com/openai/x/application',
          workplaceType: 'Hybrid',
          employmentType: 'FullTime',
          department: 'Research',
          descriptionHtml: '<p>Build</p>',
          address: {
            postalAddress: {
              addressLocality: 'San Francisco',
              addressRegion: 'California',
              addressCountry: 'United States',
            },
          },
          secondaryLocations: [
            {
              location: 'London',
              address: {
                postalAddress: { addressLocality: 'London', addressCountry: 'United Kingdom' },
              },
            },
          ],
          compensation: {
            summaryComponents: [
              {
                compensationType: 'EquityCashValue',
                currencyCode: 'USD',
                interval: '1 YEAR',
                minValue: 1,
                maxValue: 2,
              },
              {
                compensationType: 'Salary',
                currencyCode: 'USD',
                interval: '1 YEAR',
                minValue: 257000,
                maxValue: 335000,
              },
            ],
          },
        },
        {
          id: 'hidden',
          title: 'Hidden',
          isListed: false,
          jobUrl: 'https://jobs.ashbyhq.com/openai/hidden',
        },
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      workplaceType: 'hybrid',
      employmentTypes: ['full_time'],
      department: 'Research',
      salary: { min: 257_000, max: 335_000, currency: 'USD', interval: 'year' },
    });
    expect(listings[0].locations.map((location) => location.countryCode)).toEqual(['US', 'GB']);
  });

  it('reads a Personio board, its titled sections and its stated levels', () => {
    const xml = `<?xml version="1.0"?><workzag-jobs><position>
      <id>2800938</id><subcompany>1KOMMA5° GmbH</subcompany><office>Berlin</office>
      <additionalOffices><office>Hamburg</office></additionalOffices>
      <department>Marketing</department><name>(Junior) SEO Manager (m/w/d)</name>
      <jobDescriptions>
        <jobDescription><name>Deine Position</name><value><![CDATA[<ul><li>SEO</li></ul>]]></value></jobDescription>
        <jobDescription><name>Benefits</name><value><![CDATA[<p>Bike leasing</p>]]></value></jobDescription>
      </jobDescriptions>
      <employmentType>permanent</employmentType><seniority>entry-level</seniority><schedule>full-or-part-time</schedule>
      <yearsOfExperience>1-2</yearsOfExperience><occupation>brand_and_product_marketing</occupation>
      <occupationCategory>marketing_and_product</occupationCategory>
      <salaryInformation><min>36000.00</min><max>50000.00</max><currencyCode>EUR</currencyCode><type>yearly</type></salaryInformation>
      <createdAt>2026-09-17T07:57:12+00:00</createdAt></position></workzag-jobs>`;
    const [job] = parse('personio', '1komma5grad', xml).listings;
    expect(job).toMatchObject({
      title: '(Junior) SEO Manager (m/w/d)',
      employerName: '1KOMMA5° GmbH',
      canonicalUrl: 'https://1komma5grad.jobs.personio.de/job/2800938',
      employmentTypes: ['full_time', 'part_time'],
      seniority: 'entry',
      experienceRequirements: '1–2 years',
      salary: { min: 36_000, max: 50_000, currency: 'EUR', interval: 'year' },
      department: 'Marketing',
      occupationalCategory: 'Brand and product marketing',
      description: '### Deine Position\n\n- SEO\n\n### Benefits\n\nBike leasing',
    });
    expect(job.locations.map((location) => location.raw)).toEqual(['Berlin', 'Hamburg']);
    expect(() => jobFeedRequest('personio', 'acme.evil.com')).toThrow();
  });

  it('reads Breezy remote roles as applicant regions, not workplaces', () => {
    const [job] = parse('breezy', 'duolingo', [
      {
        id: '4ab15c2e5b05',
        name: 'Country Marketing Manager',
        url: 'https://duolingo.breezy.hr/p/4ab15c2e5b05-x',
        published_date: '2026-05-28T13:00:55.828Z',
        type: { id: 'contract', name: 'Contract' },
        department: 'Marketing',
        company: { name: 'Duolingo' },
        salary: '$7 – $12 / hour',
        locations: [
          { country: { name: 'United States', id: 'US' }, is_remote: true, name: 'United States' },
        ],
        description: '<p>Mission</p>',
      },
    ]).listings;
    expect(job).toMatchObject({
      workplaceType: 'remote',
      applicantLocationRequirements: ['United States'],
      employmentTypes: ['contract'],
      salary: { min: 7, max: 12, currency: 'USD', interval: 'hour' },
    });
    expect(job.locations).toEqual([]);
  });

  it('reads Pinpoint sections and shows pay only where the employer does', () => {
    const { listings } = parse(
      'pinpoint',
      'skims',
      {
        data: [
          {
            id: '1',
            title: 'Director',
            url: 'https://skims.pinpointhq.com/en/postings/1',
            description: '<p>About</p>',
            key_responsibilities: '<ul><li>Lead</li></ul>',
            skills_knowledge_expertise: '<ul><li>ERP</li></ul>',
            benefits: '<p>Health</p>',
            compensation_visible: true,
            compensation_minimum: 90000,
            compensation_maximum: 110000,
            compensation_currency: 'USD',
            compensation_frequency: 'year',
            employment_type: 'permanent_full_time',
            workplace_type: 'hybrid',
            reporting_to: 'A Person',
            location: {
              city: 'London',
              province: 'London',
              name: 'London Office, London, United Kingdom',
            },
            job: { requisition_id: 'R1', department: { name: 'Technology' } },
          },
          {
            id: '2',
            title: 'Hidden pay',
            url: 'https://skims.pinpointhq.com/en/postings/2',
            compensation_visible: false,
            compensation_minimum: 1,
            compensation_maximum: 2,
            compensation_currency: 'USD',
            compensation_frequency: 'year',
          },
        ],
      },
      { label: 'SKIMS' },
    );
    expect(listings[0]).toMatchObject({
      employerName: 'SKIMS',
      responsibilities: '- Lead',
      qualifications: '- ERP',
      benefits: 'Health',
      workplaceType: 'hybrid',
      employmentTypes: ['full_time'],
      salary: { min: 90_000, max: 110_000, currency: 'USD', interval: 'year' },
      department: 'Technology',
      identifier: 'R1',
    });
    expect(listings[0].locations[0].countryCode).toBe('GB');
    expect(JSON.stringify(listings[0])).not.toContain('A Person');
    expect(listings[1].salary).toBeUndefined();
  });

  it('runs Teamtailor items through the shared JSON-LD extractor', () => {
    const [job] = parse('teamtailor', 'career', {
      items: [
        {
          url: 'https://career.teamtailor.com/jobs/1-ae',
          content_html: '<p>Join</p>',
          date_published: '2026-01-01T00:00:00Z',
          _jobposting: {
            '@type': 'JobPosting',
            title: 'Account Executive',
            identifier: { '@type': 'PropertyValue', value: 1 },
            hiringOrganization: { name: 'Teamtailor' },
            jobLocation: [
              { '@type': 'Place', address: { addressLocality: 'London', addressCountry: 'GB' } },
            ],
            baseSalary: {
              '@type': 'MonetaryAmount',
              currency: 'GBP',
              value: { minValue: 50000, maxValue: 60000, unitText: 'YEAR' },
            },
          },
        },
      ],
    }).listings;
    expect(job).toMatchObject({
      title: 'Account Executive',
      employerName: 'Teamtailor',
      canonicalUrl: 'https://career.teamtailor.com/jobs/1-ae',
      salary: { min: 50_000, max: 60_000, currency: 'GBP', interval: 'year' },
      identifier: '1',
    });
    expect(job.description).toBe('Join');
    expect(job.evidence.title.source).toBe('feed');
  });

  it('folds Rippling location rows into one job and completes it from its detail', () => {
    const rows = {
      items: [
        {
          id: 'j1',
          name: 'BizOps Manager',
          url: 'https://ats.rippling.com/rippling/jobs/j1',
          department: { name: 'Bizops' },
          locations: [
            {
              name: 'San Francisco, CA',
              city: 'San Francisco',
              state: 'California',
              country: 'United States',
              countryCode: 'US',
              workplaceType: 'ON_SITE',
            },
          ],
        },
        {
          id: 'j1',
          name: 'BizOps Manager',
          url: 'https://ats.rippling.com/rippling/jobs/j1',
          department: { name: 'Bizops' },
          locations: [
            {
              name: 'New York, NY',
              city: 'New York',
              state: 'New York',
              country: 'United States',
              countryCode: 'US',
              workplaceType: 'ON_SITE',
            },
          ],
        },
      ],
      totalPages: 1,
    };
    const page = parse('rippling', 'rippling', rows);
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0].locations).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
    const { request, listing } = detail('rippling', 'rippling', rows, {
      name: 'BizOps Manager',
      companyName: 'Rippling',
      description: { company: '<p>About</p>', role: '<p>Role</p>' },
      employmentType: { label: 'SALARIED_FT', id: 'Salaried, full-time' },
      createdOn: '2026-03-31T17:37:26.093000-07:00',
      payRangeDetails: [
        { currency: 'USD', frequency: 'YEAR', rangeStart: 170000, rangeEnd: 250000 },
      ],
    });
    expect(request.url).toBe('https://ats.rippling.com/api/v2/board/rippling/jobs/j1');
    expect(listing).toMatchObject({
      workplaceType: 'onsite',
      employmentTypes: ['full_time'],
      description: 'About\n\nRole',
      salary: { min: 170_000, max: 250_000, currency: 'USD', interval: 'year' },
    });
    expect(
      detail('rippling', 'rippling', rows, { unlistedFromSearch: true }).listing,
    ).toBeUndefined();
  });

  it('completes BambooHR openings from their detail without reading the application form', () => {
    const list = {
      result: [
        {
          id: '106',
          jobOpeningName: 'LATAM Market Manager',
          departmentLabel: 'Marketing',
          employmentStatusLabel: 'Regular - Full-Time',
          atsLocation: { country: 'Brazil' },
        },
      ],
    };
    const { request, listing } = detail('bamboohr', 'prezi', list, {
      result: {
        jobOpening: {
          jobOpeningShareUrl: 'https://prezi.bamboohr.com/careers/106',
          jobOpeningStatus: 'Open',
          description: '<p>Grow LATAM</p>',
          datePosted: '2025-09-25',
          minimumExperience: 'Mid-level',
          atsLocation: { country: 'Brazil' },
        },
        formFields: { email: { label: 'Email' } },
      },
    });
    expect(request.url).toBe('https://prezi.bamboohr.com/careers/106/detail');
    expect(listing).toMatchObject({
      employmentTypes: ['full_time'],
      seniority: 'mid',
      description: 'Grow LATAM',
      department: 'Marketing',
    });
    expect(listing?.locations[0].countryCode).toBe('BR');
    expect(JSON.stringify(listing)).not.toContain('Email');
  });

  it('pages Workday by offset inside its 2,000-row window and completes rows from their detail', () => {
    const list = {
      total: 2000,
      jobPostings: Array.from({ length: 20 }, (_, index) => ({
        title: `Engineer ${index}`,
        externalPath: `/job/US-CA-Santa-Clara/Engineer-${index}_JR${index}`,
        bulletFields: [`JR${index}`],
      })),
    };
    const first = parse('workday', 'nvidia.wd5/NVIDIAExternalCareerSite', list, {
      label: 'NVIDIA',
    });
    expect(first.listings[0]).toMatchObject({
      employerName: 'NVIDIA',
      identifier: 'JR0',
      canonicalUrl:
        'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer-0_JR0',
    });
    expect(first.nextCursor).toBe('20');
    expect(
      parse(
        'workday',
        'nvidia.wd5/NVIDIAExternalCareerSite',
        { ...list, total: 0 },
        { cursor: '1980' },
      ).nextCursor,
    ).toBeUndefined();
    const { request, listing } = detail(
      'workday',
      'nvidia.wd5/NVIDIAExternalCareerSite',
      list,
      {
        jobPostingInfo: {
          title: 'Engineer 0',
          jobDescription: '<p>Inference</p>',
          location: 'US, CA, Santa Clara',
          additionalLocations: ['US, Remote'],
          timeType: 'Full time',
          startDate: '2026-10-09',
          jobReqId: 'JR0',
          posted: true,
          jobRequisitionLocation: {
            descriptor: 'US, CA, Santa Clara',
            country: { alpha2Code: 'US' },
          },
          externalUrl:
            'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer-0_JR0',
        },
      },
      'NVIDIA',
    );
    expect(request.url).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer-0_JR0',
    );
    expect(listing).toMatchObject({
      description: 'Inference',
      employmentTypes: ['full_time'],
      identifier: 'JR0',
    });
    expect(listing?.locations[0]).toMatchObject({ raw: 'US, CA, Santa Clara', countryCode: 'US' });
    expect(listing?.publishedAt?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('aggregator providers', () => {
  it('never reads AI Dev Jobs promotion or ranking fields, and pages by number', () => {
    const page = parse('aidevboard', 'aidevboard', {
      has_next: true,
      jobs: [
        {
          id: 'u1',
          title: 'Sr Data Scientist',
          company_name: 'Dataiku',
          url: 'https://aidevboard.com/job/u1',
          apply_url: 'https://job-boards.greenhouse.io/dataiku/jobs/1',
          location: 'New York, NY',
          workplace: 'onsite',
          job_type: 'full-time',
          experience_level: 'principal',
          salary_min: 210000,
          salary_max: 220000,
          tags: ['mlops'],
          is_featured: true,
          is_sticky: true,
          quality_score: 90,
          published_at: '2026-09-14T05:15:34Z',
          expires_at: '2026-10-14T13:38:13Z',
        },
      ],
    });
    expect(page.nextCursor).toBe('2');
    expect(page.listings[0]).toMatchObject({
      applyUrl: 'https://job-boards.greenhouse.io/dataiku/jobs/1',
      seniority: 'lead',
      employmentTypes: ['full_time'],
      salary: { min: 210_000, max: 220_000, currency: 'USD', interval: 'year' },
      skills: ['mlops'],
    });
    expect(JSON.stringify(page.listings[0])).not.toMatch(/featured|sticky|quality/i);
  });

  it('reads DevITjobs XML with its stable id and a stated salary', () => {
    const xml = `<jobs><job id="60759a28a4a6990017d94bf3-W41">
      <id><![CDATA[60759a28a4a6990017d94bf3-W41]]></id><ispromoted><![CDATA[true]]></ispromoted><cpc><![CDATA[0.1]]></cpc>
      <title><![CDATA[Web portal Developer]]></title><url><![CDATA[https://devitjobs.uk/jobs/EllisKnight-Web-portal-Developer]]></url>
      <country><![CDATA[United Kingdom]]></country><region><![CDATA[London]]></region><city><![CDATA[London]]></city>
      <postal_code><![CDATA[RG8 7JW]]></postal_code><company-name><![CDATA[EllisKnight]]></company-name>
      <salary><![CDATA[£35,000 - 40,000 per year]]></salary><job-type><![CDATA[Full-Time]]></job-type>
      <pubdate><![CDATA[04.10.2023]]></pubdate><description><![CDATA[<p>Build portals</p>]]></description></job>
      <job id="x"><id><![CDATA[x-W41]]></id><title><![CDATA[Remote role]]></title><url><![CDATA[https://devitjobs.uk/jobs/x]]></url>
      <company-name><![CDATA[Acme]]></company-name><location><![CDATA[Full Remote]]></location><salary><![CDATA[£? - ? per year]]></salary></job></jobs>`;
    const { listings } = parse('devitjobs', 'devitjobs.uk', xml);
    expect(listings[0]).toMatchObject({
      identifier: '60759a28a4a6990017d94bf3',
      employmentTypes: ['full_time'],
      salary: { min: 35_000, max: 40_000, currency: 'GBP', interval: 'year' },
    });
    expect(listings[0].locations[0]).toMatchObject({
      countryCode: 'GB',
      locality: 'London',
      postalCode: 'RG8 7JW',
    });
    expect(listings[0].publishedAt?.toISOString()).toBe('2023-10-04T00:00:00.000Z');
    expect(listings[1]).toMatchObject({ workplaceType: 'remote' });
    expect(listings[1].salary).toBeUndefined();
  });

  it('reads Jobicy and stops when it says there is no more', () => {
    const page = parse('jobicy', 'jobicy', {
      hasMore: false,
      nextCursor: 'abc',
      jobs: [
        {
          id: 154956,
          url: 'https://jobicy.com/jobs/154956-ae',
          jobTitle: 'Account Executive',
          companyName: 'Juniper Square',
          jobIndustry: ['Sales'],
          jobType: ['Full-Time'],
          jobGeo: 'Canada,  USA',
          jobLevel: 'Entry-Level, Junior',
          salaryMin: 120000,
          salaryMax: 145000,
          salaryCurrency: 'USD',
          salaryPeriod: 'yearly',
          pubDate: '2026-10-09T18:42:49+00:00',
        },
      ],
    });
    expect(page.nextCursor).toBeUndefined();
    expect(page.listings[0]).toMatchObject({
      workplaceType: 'remote',
      applicantLocationRequirements: ['Canada', 'USA'],
      seniority: 'entry',
      salary: { min: 120_000, max: 145_000, currency: 'USD', interval: 'year' },
      occupationalCategory: 'Sales',
    });
  });

  it('reads 4dayweek amounts in cents and its schedule as a benefit', () => {
    const [job] = parse('fourdayweek', 'fourdayweek', {
      has_more: false,
      data: [
        {
          id: 'u',
          title: 'Staff Data Scientist',
          url: 'https://4dayweek.io/job/x',
          description: '- Own strategy',
          level: 'senior',
          contract_type: 'permanent',
          schedule_type: '9_day_fortnight',
          work_arrangement: 'remote',
          role: 'Data Scientist',
          locations: [{ city: 'Manhattan', state: 'New York', country: 'United States' }],
          salary_min: 19200000,
          salary_max: 24000000,
          salary_currency: 'USD',
          salary_period: 'year',
          skills: [{ name: 'Applied Research' }],
          stack: [{ name: 'LLMs' }],
          tools: [{ name: 'MX' }],
          company: {
            name: 'Zip Co',
            website: 'https://zip.co',
            logo_url: 'https://media.4dayweek.io/l.jpg',
          },
          posted_at: '2026-10-07T20:52:22Z',
        },
      ],
    }).listings;
    expect(job).toMatchObject({
      employerName: 'Zip Co',
      employerUrl: 'https://zip.co/',
      seniority: 'senior',
      workplaceType: 'remote',
      salary: { min: 192_000, max: 240_000, currency: 'USD', interval: 'year' },
      skills: ['Applied Research', 'LLMs', 'MX'],
      benefits: '- 9 day fortnight',
      occupationalCategory: 'Data Scientist',
    });
    expect(job.employmentTypes).toEqual([]);
  });

  it('reads JobTech ads and never their contact people', () => {
    const [job] = parse('jobtech', 'jobtech', {
      total: { value: 1 },
      hits: [
        {
          id: '31580065',
          webpage_url: 'https://arbetsformedlingen.se/platsbanken/annonser/31580065',
          headline: 'Lärare',
          employer: { name: 'Hörby kommun', workplace: 'Kultur- och utbildningsförvaltningen' },
          application_details: { url: 'https://recruit.example/apply' },
          description: { text_formatted: 'Att arbeta i Hörby.' },
          working_hours_type: { label: 'Heltid' },
          employment_type: { label: 'Vanlig anställning' },
          workplace_model: { label: 'Arbete på plats' },
          workplace_addresses: [
            { city: 'Hörby', region: 'Skåne län', country: 'Sverige', postcode: '24280' },
          ],
          must_have: {
            skills: [{ label: 'Svenska' }],
            education: [],
            work_experiences: [{ label: 'Lärare' }],
          },
          occupation: { label: 'Lärare i grundskolan' },
          occupation_field: { label: 'Pedagogik' },
          application_contacts: [
            { name: 'Patrik Gärd', email: 'patrik@example.se', telephone: '+46415378401' },
          ],
          publication_date: '2026-10-10T01:35:11',
          application_deadline: '2026-10-25T23:59:59',
        },
      ],
    }).listings;
    expect(job).toMatchObject({
      employmentTypes: ['full_time'],
      workplaceType: 'onsite',
      applyUrl: 'https://recruit.example/apply',
      skills: ['Svenska'],
      experienceRequirements: '- Lärare',
      department: 'Kultur- och utbildningsförvaltningen',
    });
    expect(job.locations[0]).toMatchObject({ countryCode: 'SE', locality: 'Hörby' });
    expect(JSON.stringify(job)).not.toMatch(/Patrik|patrik@|\+46415378401/);
  });

  it('reads the employer out of We Work Remotely titles and drops items without one', () => {
    const rss = `<rss><channel><title>We Work Remotely</title>
      <item><media:content url="https://wwr.example/logo.gif" type="image/png"/><title>RETR: Customer Success Manager</title>
      <region>USA Only</region><category>Sales and Marketing</category><type>Full-Time</type>
      <pubDate>Fri, 09 Oct 2026 17:46:45 +0000</pubDate><expires_at>Sun, 08 Nov 2026 17:46:45 +0000</expires_at>
      <guid>https://weworkremotely.com/remote-jobs/retr-csm</guid><link>https://weworkremotely.com/remote-jobs/retr-csm</link></item>
      <item><title>No company prefix</title><link>https://weworkremotely.com/remote-jobs/x</link></item></channel></rss>`;
    const { listings } = parse('weworkremotely', 'weworkremotely', rss);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      title: 'Customer Success Manager',
      employerName: 'RETR',
      employerLogoUrl: 'https://wwr.example/logo.gif',
      applicantLocationRequirements: ['USA Only'],
      employmentTypes: ['full_time'],
      occupationalCategory: 'Sales and Marketing',
    });
  });

  it('pages freehire within its 10,000-row window and never reads closed jobs', () => {
    const jobs = Array.from({ length: 100 }, (_, index) => ({
      public_slug: `job-${index}`,
      title: `Role ${index}`,
      company: 'Acme',
      url: `https://acme.example/${index}?utm_source=freehire.me`,
      location: 'Altoona, IA',
      countries: ['us'],
      work_mode: 'onsite',
      ...(index === 0 ? { closed_at: '2026-10-01T00:00:00Z' } : {}),
    }));
    const page = parse(
      'freehire',
      'freehire',
      { data: jobs, meta: { total: 4_000_000 } },
      { cursor: '9800' },
    );
    expect(page.listings).toHaveLength(99);
    expect(page.listings[0].locations[0]).toMatchObject({
      raw: 'Altoona, IA',
      region: 'IA',
      countryCode: 'US',
    });
    expect(page.nextCursor).toBe('9900');
    expect(
      parse('freehire', 'freehire', { data: jobs, meta: { total: 4_000_000 } }, { cursor: '9900' })
        .nextCursor,
    ).toBeUndefined();
  });
});
