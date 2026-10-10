import { describe, expect, it } from 'vitest';

import { boardFromUrl } from '../discovery.js';

describe('board discovery', () => {
  it('recognizes the ATS boards Clarity can read directly from a listing or apply URL', () => {
    const cases: Array<[string, string, string]> = [
      ['https://job-boards.greenhouse.io/anthropic/jobs/5443882008', 'greenhouse', 'anthropic'],
      ['https://boards.greenhouse.io/embed/job_app?for=stripe&token=123', 'greenhouse', 'stripe'],
      ['https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9882bf1/apply', 'lever', 'spotify'],
      ['https://jobs.eu.lever.co/olx/ff926e8f', 'lever_eu', 'olx'],
      ['https://jobs.ashbyhq.com/openai/8fb1615c/application', 'ashby', 'openai'],
      ['https://apply.workable.com/huggingface/j/81B46579FE/', 'workable', 'huggingface'],
      ['https://bunq.recruitee.com/o/deputy-aml-manager', 'recruitee', 'bunq'],
      ['https://1komma5grad.jobs.personio.de/job/2800938', 'personio', '1komma5grad'],
      ['https://duolingo.breezy.hr/p/4ab15c2e5b05-x', 'breezy', 'duolingo'],
      ['https://skims.pinpointhq.com/en/postings/932035af', 'pinpoint', 'skims'],
      ['https://career.teamtailor.com/jobs/8118064-uk-ae', 'teamtailor', 'career'],
      ['https://prezi.bamboohr.com/careers/106', 'bamboohr', 'prezi'],
      ['https://ats.rippling.com/rippling/jobs/84d388b6', 'rippling', 'rippling'],
      ['https://jobs.gem.com/fetch/7536752003', 'gem', 'fetch'],
      ['https://www.careers-page.com/manatal/job/QW3VVV8W', 'manatal', 'manatal'],
      ['https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/x_JR1', 'workday', 'nvidia.wd5/NVIDIAExternalCareerSite'],
      ['https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site/job/x', 'workday', 'salesforce.wd12/External_Career_Site'],
    ];
    for (const [url, kind, identifier] of cases) expect(boardFromUrl(url), url).toEqual({ kind, identifier });
  });

  it('recognizes nothing it cannot read as a board', () => {
    for (const url of [
      'https://apply.workable.com/j/81B46579FE',
      'https://www.recruitee.com/pricing',
      'https://a.b.recruitee.com/o/x',
      'https://jobs.smartrecruiters.com/Ubisoft2/123',
      'https://stripe.com/jobs/search?gh_jid=1',
      'https://boards.greenhouse.io/embed/job_app?token=1',
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/site/jobs',
      'javascript:alert(1)',
      'not a url',
      undefined,
    ]) expect(boardFromUrl(url), String(url)).toBeUndefined();
  });
});
