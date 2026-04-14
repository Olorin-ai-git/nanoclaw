import { describe, expect, it } from 'vitest';

import { parseProspectsFile } from './prospect-pipeline.js';

describe('parseProspectsFile', () => {
  it('returns all-zero result for empty string', () => {
    const result = parseProspectsFile('');
    expect(result).toEqual({
      unsent_count: 0,
      total_prospects: 0,
      last_outreach_date: null,
    });
  });

  it('returns all-zero result for whitespace/blank-only content', () => {
    const result = parseProspectsFile('   \n\n   \n  ');
    expect(result).toEqual({
      unsent_count: 0,
      total_prospects: 0,
      last_outreach_date: null,
    });
  });

  it('counts 3 unsent prospects when no sent markers are present', () => {
    const content = `
- alice@example.com
- bob@example.com
- carol@example.com
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(3);
    expect(result.unsent_count).toBe(3);
    expect(result.last_outreach_date).toBeNull();
  });

  it('counts sent lines correctly with sent/delivered/outreached markers', () => {
    const content = `
- alice@example.com sent on 2026-01-05
- bob@example.com delivered 2026-02-01
- carol@example.com outreached 2026-03-10
- dave@example.com
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(4);
    expect(result.unsent_count).toBe(1);
  });

  it('skips lines that lack an email address', () => {
    const content = `
- no email here
- alice@example.com
- also no email
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(1);
  });

  it('skips lines that do not start with -, *, or |', () => {
    const content = `
- alice@example.com
  bob@example.com
  carol@example.com
Just a plain line: dave@example.com
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(1);
  });

  it('counts pipe-prefixed lines (table row format)', () => {
    const content = `
| alice@example.com | sent on 2026-01-05 |
| bob@example.com   |                    |
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(2);
    expect(result.unsent_count).toBe(1);
  });

  it('picks the maximum date across multiple sent lines', () => {
    const content = `
- alice@example.com sent on 2026-01-05
- bob@example.com outreach 2026-03-15
- carol@example.com contacted 2026-02-20
`;
    const result = parseProspectsFile(content);
    expect(result.last_outreach_date).toBe('2026-03-15');
  });

  it('does not update last_outreach_date for sent lines with no date', () => {
    const content = `
- alice@example.com sent
- bob@example.com delivered
`;
    const result = parseProspectsFile(content);
    expect(result.unsent_count).toBe(0);
    expect(result.total_prospects).toBe(2);
    expect(result.last_outreach_date).toBeNull();
  });

  it('handles a realistic mix: 5 lines, 2 unsent, 3 sent (one with date), one junk', () => {
    const content = `
- alice@example.com sent on 2026-01-10
- bob@example.com delivered
- carol@example.com outreached 2026-03-01
- dave@example.com
- eve@example.com
Just a junk line with frank@example.com but no bullet
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(5);
    expect(result.unsent_count).toBe(2);
    expect(result.last_outreach_date).toBe('2026-03-01');
  });

  it('supports star-prefixed lines', () => {
    const content = `
* alice@example.com sent on 2026-02-14
* bob@example.com
`;
    const result = parseProspectsFile(content);
    expect(result.total_prospects).toBe(2);
    expect(result.unsent_count).toBe(1);
    expect(result.last_outreach_date).toBe('2026-02-14');
  });
});
