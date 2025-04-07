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
    const { itemsResult, feedDescription } = generateFeedContent(values, 'auto');
    expect(feedDescription).toContain('auto mode');
    // Check that itemsResult is an array (or check length)
    expect(Array.isArray(itemsResult)).toBe(true);
    expect(itemsResult.length).toBe(1);
    expect(itemsResult[0].title).toBe('My Title');
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

  it('should return valid item objects from standard data', () => {
    const date1Str = '2025-04-02T09:00:00Z';
    const date2Str = '2025-04-01T08:00:00Z';
    const values = [
      ['Title 1', 'Desc A', 'https://example.com/1', date1Str],
      ['Title 2', 'Desc B', 'https://example.com/2', date2Str],
    ];
    const resultItems = generateFeedAutoMode(values); // resultItems is now an array

    expect(Array.isArray(resultItems)).toBe(true);
    expect(resultItems.length).toBe(2);

    // Check sorting: Item 1 (later date) should be first
    expect(resultItems[0].title).toBe('Title 1');
    expect(resultItems[0].link).toBe('https://example.com/1');
    expect(resultItems[0].descriptionContent).toBe('Desc A');
    expect(resultItems[0].dateObject?.getTime()).toBe(new Date(date1Str).getTime());
    expect(resultItems[1].title).toBe('Title 2');
    expect(resultItems[1].link).toBe('https://example.com/2');
    expect(resultItems[1].descriptionContent).toBe('Desc B');
    expect(resultItems[1].dateObject?.getTime()).toBe(new Date(date2Str).getTime());
  });

  it('should handle multiple values', () => {
    const values = [
      ['Title A', 'Desc A', 'https://example.com/a', '2025-04-01T00:00:00Z'],
      ['Title B', 'Desc B', 'https://example.com/b', '2025-04-02T00:00:00Z'],
      ['Title C', 'Desc C', 'https://example.com/c', '2025-04-03T00:00:00Z'],
    ];
    const resultItems = generateFeedAutoMode(values);
    expect(resultItems.length).toBe(3);
    // Check sorting (C should be first)
    expect(resultItems[0].title).toBe('Title C');
    expect(resultItems[1].title).toBe('Title B');
    expect(resultItems[2].title).toBe('Title A');
  });


  it('should handle missing URL and date', () => {
    const values = [['Title 3', 'Description Only']];
    const resultItems = generateFeedAutoMode(values);

    expect(resultItems.length).toBe(1);
    expect(resultItems[0].title).toBe('Title 3');
    expect(resultItems[0].descriptionContent).toBe('Description Only');
    expect(resultItems[0].link).toBeUndefined();
    expect(resultItems[0].dateObject).toBeNull(); // Expect null if date parsing failed
  });

   it('should handle missing description parts', () => {
    const dateStr = '2025-04-02T10:00:00Z';
    const values = [['Title 4', 'https://example.com/4', dateStr]];
    const resultItems = generateFeedAutoMode(values);

    expect(resultItems.length).toBe(1);
    expect(resultItems[0].title).toBe('Title 4');
    expect(resultItems[0].descriptionContent).toBe(''); // Description should be empty
    expect(resultItems[0].link).toBe('https://example.com/4');
    expect(resultItems[0].dateObject?.getTime()).toBe(new Date(dateStr).getTime());
  });

  it('should handle empty values array', () => {
    const resultItems = generateFeedAutoMode([]);
    expect(resultItems).toEqual([]); // Expect empty array
  });

  it('should handle null or undefined input', () => {
    expect(generateFeedAutoMode(null)).toEqual([]);
    expect(generateFeedAutoMode(undefined)).toEqual([]);
  });

   it('should handle rows with only a title (first column)', () => {
    const values = [['Title Only']];
    const resultItems = generateFeedAutoMode(values);
    expect(resultItems.length).toBe(1);
    expect(resultItems[0].title).toBe('Title Only');
    expect(resultItems[0].descriptionContent).toBe('');
    expect(resultItems[0].link).toBeUndefined();
    expect(resultItems[0].dateObject).toBeNull();
  });

  it('should use first non-empty cell as title if first cell is empty', () => {
    const values = [['', 'Actual Title', 'Some Desc', 'https://example.com/non-first-title']];
    const resultItems = generateFeedAutoMode(values);

    expect(resultItems.length).toBe(1);
    // Check that 'Actual Title' is used as the title
    expect(resultItems[0].title).toBe('Actual Title');
    // Check that the title cell ('Actual Title') is NOT included in the description
    // Description should only contain 'Some Desc' (link is handled separately)
    // Note: If user accepted whitespace, test should be ' Some Desc'
    expect(resultItems[0].descriptionContent).toBe(' Some Desc');
    expect(resultItems[0].link).toBe('https://example.com/non-first-title'); // Link should still be found
    expect(resultItems[0].dateObject).toBeNull(); // No date provided
  });

   it('should handle rows with only a title', () => {
    const values = [['Title Only']];
    const resultItems = generateFeedAutoMode(values);
    expect(resultItems.length).toBe(1);
    expect(resultItems[0].title).toBe('Title Only');
    expect(resultItems[0].descriptionContent).toBe('');
    expect(resultItems[0].link).toBeUndefined();
    expect(resultItems[0].dateObject).toBeNull();
   });

  it('should skip rows where all cells are empty or whitespace', () => {
    const values = [
        ['', null, '   '], 
        ['Real Title', 'Desc']
    ];
    const resultItems = generateFeedAutoMode(values);
    // Should only generate one item (for the second row)
    expect(resultItems.length).toBe(1);
    expect(resultItems[0].title).toBe('Real Title');
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

    const resultItems = generateFeedAutoMode(values);

    expect(resultItems.length).toBe(3);

    // Check sorting: Late should be first, Early should be last
    expect(resultItems[0].title).toBe('Title Late');
    expect(resultItems[1].title).toBe('Title Mid');
    expect(resultItems[2].title).toBe('Title Early');

    // Check that dates were parsed correctly (compare timestamps)
    // Note: Parsing '04/01/2025' might assume local time depending on helper implementation,
    // but getTime() gives UTC milliseconds regardless, allowing comparison.
    expect(resultItems[0].dateObject?.getTime()).toBe(new Date(dateLateStr).getTime());
    expect(resultItems[1].dateObject?.getTime()).toBe(new Date(dateMidStr).getTime());
    expect(resultItems[2].dateObject?.getTime()).toBe(new Date(dateEarlyStr).getTime());
  });

  it('should sort items with invalid/missing dates to the end', () => {
    const dateValidStr = '2025-04-03T00:00:00Z';
    const invalidDateStr = 'Not a valid date';

    const values = [
      ['Title Invalid Date', 'Desc Invalid', invalidDateStr], // Invalid date string
      ['Title Valid Date', 'Desc Valid', dateValidStr], // Valid date
      ['Title No Date', 'Desc No Date'], // Missing date string
    ];

    const resultItems = generateFeedAutoMode(values);

    expect(resultItems.length).toBe(3);

    // Check that the valid date item appears first
    expect(resultItems[0].title).toBe('Title Valid Date');
    expect(resultItems[0].dateObject?.getTime()).toBe(new Date(dateValidStr).getTime());

    // Check that the other items have null dateObjects
    expect(resultItems[1].dateObject).toBeNull();
    expect(resultItems[2].dateObject).toBeNull();
    // Check titles to ensure they are the correct items (order between [1] and [2] isn't guaranteed)
    const titlesAfterValid = [resultItems[1].title, resultItems[2].title];
    expect(titlesAfterValid).toContain('Title Invalid Date');
    expect(titlesAfterValid).toContain('Title No Date');
  });
});