const { generateFeedContent, generateFeedAutoMode, generateFeedManualMode } = require('./index');
const { format } = require('date-fns'); // Import format for creating expected date strings
const { parseISO } = require('date-fns'); // Import parseISO for convenience in tests

// Define a fixed point in time for mocking 'now'
const MOCK_NOW_TIMESTAMP = new Date('2025-04-03T10:30:00.000Z').getTime();
// Calculate the expected RFC 822 string for the mocked 'now' time ONCE
const MOCK_NOW_RFC822 = format(new Date(MOCK_NOW_TIMESTAMP), "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });

// Helper to format dates consistently for expectations (using Original Date logic for parsing test inputs)
const formatToRFC822 = (dateString) => {
    // Attempt to parse the input string using various methods Date understands or ISO
    let date = parseISO(dateString); // Try ISO first
    if (isNaN(date)) {
        // Try RFC 822 format specifically if ISO fails (common input)
        // Note: 'parse' might be needed from date-fns for robust RFC822 parsing if new Date() fails
        date = new Date(dateString); // Fallback to standard Date parsing
    }

    if (isNaN(date)) {
        // Handle invalid input date strings if necessary, maybe return mock date?
        console.warn(`formatToRFC822 failed to parse: ${dateString}`);
        return MOCK_NOW_RFC822;
    }
    // Format using the required RFC 822 structure in GMT
    return format(date, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
};


describe('generateFeedContent', () => {

  it('should call generateFeedAutoMode when mode is "auto" or undefined', () => {
    const values = [['My Title', 'My Desc', 'https://example.com/auto', '2025-04-03T11:00:00Z']];
    const { xmlItems, feedDescription } = generateFeedContent(values, 'auto');
    expect(feedDescription).toContain('auto mode');
    expect(xmlItems).toContain('<item>');
    expect(xmlItems).toContain('My Title');
  });
});

describe('generateFeedAutoMode', () => {
  // Use Jest fake timers to control 'new Date()' for fallback dates
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(MOCK_NOW_TIMESTAMP));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('should generate valid XML items from standard data', () => {
    const date1Str = '2025-04-02T09:00:00Z';
    const date2Str = '2025-04-01T08:00:00Z';
    const values = [
      ['Title 1', 'Desc A', 'https://example.com/1', date1Str],
      ['Title 2', 'Desc B', 'https://example.com/2', date2Str],
    ];
    const result = generateFeedAutoMode(values);

    expect(result.match(/<item>/g)?.length).toBe(2);
    expect(result).toContain('<title><![CDATA[Title 1]]></title>');
    expect(result).toContain('<description><![CDATA[Desc A]]></description>');
    expect(result).toContain(`<pubDate>${formatToRFC822(date1Str)}</pubDate>`);
    expect(result).toContain('<title><![CDATA[Title 2]]></title>');
    expect(result).toContain('<description><![CDATA[Desc B]]></description>');
    expect(result).toContain(`<pubDate>${formatToRFC822(date2Str)}</pubDate>`);
    // Check sorting implicitly by order of appearance (Title 1 should appear first)
    expect(result.indexOf('Title 1')).toBeLessThan(result.indexOf('Title 2'));
  });

  it('should use first non-empty cell as title if first cell is empty', () => {
    const values = [['', 'Actual Title', 'Some Desc', 'https://example.com/non-first-title']];
    const result = generateFeedAutoMode(values);

    expect(result).toContain('<item>');
    // Check that 'Actual Title' is used as the title
    expect(result).toContain('<title><![CDATA[Actual Title]]></title>');
    expect(result).toContain('<description><![CDATA[ Some Desc]]></description>');
    expect(result).toContain('<link><![CDATA[https://example.com/non-first-title]]></link>'); // Link should still be found
    expect(result).toContain(`<pubDate>${MOCK_NOW_RFC822}</pubDate>`); // Fallback date
    expect(result).toContain('</item>');
  });

  it('should handle missing URL and date, using fallback date and no link/guid', () => {
    const values = [['Title 3', 'Description Only']];
    const result = generateFeedAutoMode(values);

    expect(result).toContain('<item>');
    expect(result).toContain('<title><![CDATA[Title 3]]></title>');
    expect(result).toContain('<description><![CDATA[Description Only]]></description>');
    expect(result).not.toContain('<link>');
    expect(result).not.toContain('<guid');
    // Check that the fallback date (mocked 'now') is used
    expect(result).toContain(`<pubDate>${MOCK_NOW_RFC822}</pubDate>`);
    expect(result).toContain('</item>');
  });

   it('should handle missing description parts', () => {
    const dateStr = '2025-04-02T10:00:00Z';
    const values = [['Title 4', 'https://example.com/4', dateStr]];
    const result = generateFeedAutoMode(values);

    expect(result).toContain('<item>');
    expect(result).toContain('<title><![CDATA[Title 4]]></title>');
    expect(result).toContain('<description><![CDATA[]]></description>'); // Empty description
    expect(result).toContain('<link><![CDATA[https://example.com/4]]></link>');
    expect(result).toContain('<guid><![CDATA[https://example.com/4]]></guid>');
    expect(result).toContain(`<pubDate>${formatToRFC822(dateStr)}</pubDate>`);
    expect(result).toContain('</item>');
  });

   it('should handle rows with only a title', () => {
    const values = [['Title Only']];
    const result = generateFeedAutoMode(values);
    expect(result).toContain('<item>');
    expect(result).toContain('<title><![CDATA[Title Only]]></title>');
    expect(result).toContain('<description><![CDATA[]]></description>');
    expect(result).not.toContain('<link>');
    expect(result).not.toContain('<guid');
    expect(result).toContain(`<pubDate>${MOCK_NOW_RFC822}</pubDate>`); // Check fallback date
    expect(result).toContain('</item>');
  });

  it('should skip rows where all cells are empty or whitespace', () => {
    const values = [
        ['', null, '   '], 
        ['Real Title', 'Desc']
    ];
    const result = generateFeedAutoMode(values);
    // Should only generate one item (for the second row)
    expect(result.match(/<item>/g)?.length).toBe(1);
    expect(result).toContain('Real Title');
    expect(result).not.toContain('<title><![CDATA[]]></title>'); // Ensure no item from empty row
    expect(result).not.toContain('<title><![CDATA[null]]></title>'); // Ensure no item from empty row
    expect(result).not.toContain('<title><![CDATA[   ]]></title>'); // Ensure no item from empty row
  });


  it('should handle empty values array', () => {
    const values = [];
    const result = generateFeedAutoMode(values);
    expect(result).toBe('');
  });

  it('should handle null or undefined input', () => {
    expect(generateFeedAutoMode(null)).toBe('');
    expect(generateFeedAutoMode(undefined)).toBe('');
  });

  // --- DATE HANDLING TESTS ---

  it('should parse various date formats and sort correctly', () => {
    const dateEarlyStr = '04/01/2025'; // US format - April 1st
    const dateMidStr = '2025-04-02T15:00:00Z'; // ISO - April 2nd 15:00 UTC
    const dateLateStr = 'Wed, 02 Apr 2025 18:30:00 GMT'; // RFC 822 - April 2nd 18:30 UTC

    const values = [
      ['Title Mid', 'Desc Mid', dateMidStr], // Middle date
      ['Title Early', 'Desc Early', dateEarlyStr], // Earliest date
      ['Title Late', 'Desc Late', dateLateStr], // Latest date
    ];

    const result = generateFeedAutoMode(values);

    expect(result.match(/<item>/g)?.length).toBe(3);

    // Check sorting using indexOf: 'Title Late' should appear before 'Title Early'
    const indexLate = result.indexOf('Title Late');
    const indexMid = result.indexOf('Title Mid');
    const indexEarly = result.indexOf('Title Early');

    expect(indexLate).toBeGreaterThan(-1); // Ensure titles are found
    expect(indexMid).toBeGreaterThan(-1);
    expect(indexEarly).toBeGreaterThan(-1);

    expect(indexLate).toBeLessThan(indexMid); // Late before Mid
    expect(indexMid).toBeLessThan(indexEarly); // Mid before Early

    // Check that dates were parsed and formatted correctly
    expect(result).toContain(`<pubDate>${formatToRFC822(dateLateStr)}</pubDate>`); // Expect Wed, 02 Apr 2025 18:30:00 GMT
    expect(result).toContain(`<pubDate>${formatToRFC822(dateMidStr)}</pubDate>`);
    expect(result).toContain(`<pubDate>${formatToRFC822(dateEarlyStr)}</pubDate>`);
  });

  it('should sort items with invalid/missing dates to the end', () => {
    const dateValidStr = '2025-04-03T00:00:00Z';
    const invalidDateStr = 'Not a valid date';

    const values = [
      ['Title Invalid Date', 'Desc Invalid', invalidDateStr], // Invalid date string
      ['Title Valid Date', 'Desc Valid', dateValidStr], // Valid date
      ['Title No Date', 'Desc No Date'], // Missing date string
    ];

    const result = generateFeedAutoMode(values);

    expect(result.match(/<item>/g)?.length).toBe(3);

    // Check that the valid date item appears first
    const indexValid = result.indexOf('Title Valid Date');
    const indexInvalid = result.indexOf('Title Invalid Date');
    const indexNoDate = result.indexOf('Title No Date');

    expect(indexValid).toBeGreaterThan(-1);
    expect(indexInvalid).toBeGreaterThan(-1);
    expect(indexNoDate).toBeGreaterThan(-1);

    expect(indexValid).toBeLessThan(indexInvalid); // Valid date item comes before invalid date item
    expect(indexValid).toBeLessThan(indexNoDate); // Valid date item comes before no date item

    // Check that the item with the valid date has the correct pubDate
    expect(result).toContain(`<pubDate>${formatToRFC822(dateValidStr)}</pubDate>`);

    // Check that the items with invalid/missing dates use the fallback date (mocked 'now')
    // Use regex to count occurrences of the fallback date string
    const fallbackDateRegex = new RegExp(MOCK_NOW_RFC822.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); // Escape regex special chars
    const fallbackDateCount = (result.match(fallbackDateRegex) || []).length;
    expect(fallbackDateCount).toBe(2); // Two items should have the fallback date
  });
});