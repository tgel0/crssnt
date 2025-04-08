const { buildFeedData, generateRssFeed } = require('./helper');
const { format, formatISO, parseISO  } = require('date-fns');

// Define a fixed point in time for mocking 'now'
const MOCK_NOW_TIMESTAMP = new Date('2025-04-03T10:30:00.000Z').getTime();
const MOCK_NOW_DATE = new Date(MOCK_NOW_TIMESTAMP);
// Calculate the expected RFC 822 string for the mocked 'now' time ONCE
const MOCK_NOW_RFC822 = format(MOCK_NOW_DATE, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });

// // Helper to format dates consistently for expectations
// const formatToRFC822 = (dateString) => {
//     let date = parseISO(dateString);
//     if (isNaN(date)) {
//         date = new Date(dateString);
//     }

//     if (isNaN(date)) {
//         console.warn(`formatToRFC822 failed to parse: ${dateString}`);
//         return MOCK_NOW_RFC822;
//     }
//     return format(date, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
// };

// Mock Date constructor and Date.now() for consistent fallback dates
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(MOCK_NOW_DATE);
});

afterAll(() => {
  jest.useRealTimers();
});

// --- Mock Input Data ---
const mockSheetTitle = 'Test Sheet <Title>'; // Include char needing escape
const mockSheetID = 'TEST_SHEET_ID_123';
const mockRequestUrl = 'https://crssnt.com/sheetToRss?id=TEST_SHEET_ID_123&extra=foo';
const mockSheetValuesAuto = [
    ['Title 1 & Done', 'Desc A', 'https://example.com/1', '2025-04-02T09:00:00Z'], // Late
    ['Title 2', 'Desc B > More', 'https://example.com/2', '2025-04-01T08:00:00Z'], // Early
    ['Title 3 No Date', 'Desc C'], // No date
    ['', 'Title 4 First NonEmpty', 'Desc D "Quoted"'], // Title not in first column
    ['Title 5 No Desc', 'https://example.com/5', '2025-04-02T10:00:00Z'], // Latest
];
const mockSheetValuesManual = [
    ['title', 'link', 'description', 'pubDate', 'customTag', 'content:encoded'], // Headers
    ['Manual Title 1', 'https://example.com/m1', 'Manual Desc A', '2025-04-01T12:00:00Z', 'Custom A', '<p>HTML Content 1</p>'],
    ['Manual Title 2', 'https://example.com/m2', 'Manual Desc B & Special', '2025-04-02T12:00:00Z', 'Custom B', '<p>HTML Content 2</p>'],
    ['Manual Title 3 No Date', 'https://example.com/m3', 'Manual Desc C', '', 'Custom C', ''],
];

// --- Tests ---

describe('buildFeedData (Helper Function)', () => {

  describe('Auto Mode', () => {
      const mode = 'auto';
      // Simulate calling buildFeedData (which internally calls generateItemData -> parseSheetRowAutoMode -> sortFeedItems)
      const feedData = buildFeedData(mockSheetValuesAuto, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
      const items = feedData.items;

      it('should return the correct metadata structure', () => {
          expect(feedData.metadata.title).toBe(mockSheetTitle);
          expect(feedData.metadata.link).toBe(`https://docs.google.com/spreadsheets/d/${mockSheetID}`);
          expect(feedData.metadata.feedUrl).toBe(mockRequestUrl);
          expect(feedData.metadata.description).toBe('Feed from Google Sheet (auto mode).');
          expect(feedData.metadata.id).toBe(`urn:google-sheet:${mockSheetID}`);
          // Check lastBuildDate is based on latest item (Title 5)
          const expectedLatestDate = parseISO('2025-04-02T10:00:00Z');
          expect(feedData.metadata.lastBuildDate.getTime()).toBe(expectedLatestDate.getTime());
      });

      it('should return the correct number of item objects', () => {
          expect(Array.isArray(items)).toBe(true);
          expect(items.length).toBe(5); // All rows have a valid title
      });

      it('should sort items correctly by date (descending)', () => {
          expect(items[0].title).toBe('Title 5 No Desc'); // Apr 2 10:00
          expect(items[1].title).toBe('Title 1 & Done'); // Apr 2 09:00
          expect(items[2].title).toBe('Title 2'); // Apr 1 08:00
          const titlesWithoutDates = [items[3].title, items[4].title];
          expect(titlesWithoutDates).toContain('Title 3 No Date');
          expect(titlesWithoutDates).toContain('Title 4 First NonEmpty');
      });

      it('should parse item properties correctly', () => {
          const item1 = items.find(i => i.title === 'Title 1 & Done');
          expect(item1.link).toBe('https://example.com/1');
          expect(item1.descriptionContent).toBe('Desc A');
          expect(item1.dateObject?.toISOString()).toBe('2025-04-02T09:00:00.000Z');

          const item4 = items.find(i => i.title === 'Title 4 First NonEmpty');
          expect(item4.link).toBeUndefined();
          expect(item4.descriptionContent).toBe('Desc D "Quoted"'); // Check description includes quotes
          expect(item4.dateObject).toBeNull();
      });
  });

  describe('Manual Mode', () => {
      const mode = 'manual';
      // Simulate calling buildFeedData (which internally calls generateItemData -> generateFeedManualModeInternal)
      const feedData = buildFeedData(mockSheetValuesManual, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
      const items = feedData.items;

       it('should return the correct metadata structure', () => {
          expect(feedData.metadata.title).toBe(mockSheetTitle);
          expect(feedData.metadata.description).toBe('Feed from Google Sheet (manual mode).');
          expect(feedData.metadata.lastBuildDate.getTime()).toBe(parseISO('2025-04-02T12:00:00Z').getTime());
      });

      it('should return the correct number of item objects', () => {
          expect(Array.isArray(items)).toBe(true);
          expect(items.length).toBe(3);
      });

      it('should map common headers to item properties', () => {
          const item1 = items[0]; // First data row
          expect(item1.title).toBe('Manual Title 2');
          expect(item1.link).toBe('https://example.com/m2');
          expect(item1.descriptionContent).toBe('Manual Desc B & Special');
          expect(item1.dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');
      });

       it('should handle missing date in manual mode', () => {
          const item3 = items[2]; // Third data row
          expect(item3.title).toBe('Manual Title 3 No Date');
          expect(item3.link).toBe('https://example.com/m3');
          expect(item3.descriptionContent).toBe('Manual Desc C');
          expect(item3.dateObject).toBeNull(); // Date string was empty
      });
  });

  describe('generateRssFeed (Helper Function)', () => {
    // Use data generated by buildFeedData for testing
    const feedData = buildFeedData(mockSheetValuesAuto, 'auto', mockSheetTitle, mockSheetID, mockRequestUrl);
    const resultXml = generateRssFeed(feedData);

    it('should return a non-empty string', () => {
        expect(typeof resultXml).toBe('string');
        expect(resultXml.length).toBeGreaterThan(0);
    });

    it('should contain RSS 2.0 root element and namespace', () => {
        expect(resultXml).toContain('<rss version="2.0"');
        expect(resultXml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
        expect(resultXml).toContain('</rss>');
    });

    it('should contain channel metadata (escaped)', () => {
        expect(resultXml).toContain(`<title>Test Sheet &lt;Title&gt;</title>`); // Check escaped title
        expect(resultXml).toContain(`<link>https://docs.google.com/spreadsheets/d/${mockSheetID}</link>`);
        expect(resultXml).toContain(`<description>Feed from Google Sheet (auto mode).</description>`);
        const expectedDate = format(feedData.metadata.lastBuildDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
        expect(resultXml).toContain(`<lastBuildDate>${expectedDate}</lastBuildDate>`);
    });

    it('should contain the correct number of items', () => {
         expect(resultXml.match(/<item>/g)?.length).toBe(feedData.items.length); // Should be 5
    });

     it('should contain correctly formatted and escaped item data (e.g., first sorted item)', () => {
        const firstItem = feedData.items[0]; // Title 5
        const expectedDate = format(firstItem.dateObject, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
        expect(resultXml).toContain(`<title><![CDATA[${firstItem.title}]]></title>`); // CDATA used
        expect(resultXml).toContain(`<description><![CDATA[${firstItem.descriptionContent}]]></description>`); // CDATA used
        expect(resultXml).toContain(`<link>${firstItem.link}</link>`); // Escaping handled by helper, assume link is safe here
        expect(resultXml).toContain(`<guid isPermaLink="true">${firstItem.link}</guid>`); // Escaping handled by helper
        expect(resultXml).toContain(`<pubDate>${expectedDate}</pubDate>`);
    });
  });

});








// describe('generateFeedContent', () => {
//   it('should call generateFeedAutoMode when mode is "auto" or undefined', () => {
//     const values = [['My Title', 'My Desc', 'https://example.com/auto', '2025-04-03T11:00:00Z']];
//     const { itemsResult, feedDescription } = generateFeedContent(values, 'auto');
//     expect(feedDescription).toContain('auto mode');
//     expect(Array.isArray(itemsResult)).toBe(true);
//     expect(itemsResult.length).toBe(1);
//     expect(itemsResult[0].title).toBe('My Title');
//   });
// });

// describe('generateFeedAutoMode', () => {
//   // Use Jest fake timers to control 'new Date()' for fallback dates
//   beforeAll(() => {
//     jest.useFakeTimers();
//     jest.setSystemTime(new Date(MOCK_NOW_TIMESTAMP));
//   });

//   afterAll(() => {
//     jest.useRealTimers();
//   });

//   // --- Standard Data Handling ---
//   it('should return valid item objects from standard data', () => {
//     const date1Str = '2025-04-02T09:00:00Z';
//     const date2Str = '2025-04-01T08:00:00Z';
//     const values = [
//       ['Title 1', 'Desc A', 'https://example.com/1', date1Str],
//       ['Title 2', 'Desc B', 'https://example.com/2', date2Str],
//     ];
//     const resultItems = generateFeedAutoMode(values);

//     expect(Array.isArray(resultItems)).toBe(true);
//     expect(resultItems.length).toBe(2);

//     // Check sorting: Item 1 (later date) should be first
//     expect(resultItems[0].title).toBe('Title 1');
//     expect(resultItems[0].link).toBe('https://example.com/1');
//     expect(resultItems[0].descriptionContent).toBe('Desc A');
//     expect(resultItems[0].dateObject?.getTime()).toBe(new Date(date1Str).getTime());
//     expect(resultItems[1].title).toBe('Title 2');
//     expect(resultItems[1].link).toBe('https://example.com/2');
//     expect(resultItems[1].descriptionContent).toBe('Desc B');
//     expect(resultItems[1].dateObject?.getTime()).toBe(new Date(date2Str).getTime());
//   });

//   it('should handle multiple values', () => {
//     const values = [
//       ['Title A', 'Desc A', 'https://example.com/a', '2025-04-01T00:00:00Z'],
//       ['Title B', 'Desc B', 'https://example.com/b', '2025-04-02T00:00:00Z'],
//       ['Title C', 'Desc C', 'https://example.com/c', '2025-04-03T00:00:00Z'],
//     ];
//     const resultItems = generateFeedAutoMode(values);
//     expect(resultItems.length).toBe(3);
//     // Check sorting (C should be first)
//     expect(resultItems[0].title).toBe('Title C');
//     expect(resultItems[1].title).toBe('Title B');
//     expect(resultItems[2].title).toBe('Title A');
//   });

//   // --- Missing Data Handling ---
//   it('should handle missing URL and date', () => {
//     const values = [['Title 3', 'Description Only']];
//     const resultItems = generateFeedAutoMode(values);

//     expect(resultItems.length).toBe(1);
//     expect(resultItems[0].title).toBe('Title 3');
//     expect(resultItems[0].descriptionContent).toBe('Description Only');
//     expect(resultItems[0].link).toBeUndefined();
//     expect(resultItems[0].dateObject).toBeNull();
//   });

//   it('should handle missing description parts', () => {
//     const dateStr = '2025-04-02T10:00:00Z';
//     const values = [['Title 4', 'https://example.com/4', dateStr]];
//     const resultItems = generateFeedAutoMode(values);

//     expect(resultItems.length).toBe(1);
//     expect(resultItems[0].title).toBe('Title 4');
//     expect(resultItems[0].descriptionContent).toBe('');
//     expect(resultItems[0].link).toBe('https://example.com/4');
//     expect(resultItems[0].dateObject?.getTime()).toBe(new Date(dateStr).getTime());
//   });

//   it('should handle empty values array', () => {
//     const resultItems = generateFeedAutoMode([]);
//     expect(resultItems).toEqual([]);
//   });

//   it('should handle null or undefined input', () => {
//     expect(generateFeedAutoMode(null)).toEqual([]);
//     expect(generateFeedAutoMode(undefined)).toEqual([]);
//   });

//   it('should use first non-empty cell as title if first cell is empty', () => {
//     const values = [['', 'Actual Title', 'Some Desc', 'https://example.com/non-first-title']];
//     const resultItems = generateFeedAutoMode(values);

//     expect(resultItems.length).toBe(1);
//     expect(resultItems[0].title).toBe('Actual Title');
//     // Check that the title cell ('Actual Title') is NOT included in the description
//     expect(resultItems[0].descriptionContent).toBe('Some Desc');
//     expect(resultItems[0].link).toBe('https://example.com/non-first-title');
//     expect(resultItems[0].dateObject).toBeNull();
//   });

//   it('should handle rows with only a title', () => {
//     const values = [['Title Only']];
//     const resultItems = generateFeedAutoMode(values);
//     expect(resultItems.length).toBe(1);
//     expect(resultItems[0].title).toBe('Title Only');
//     expect(resultItems[0].descriptionContent).toBe('');
//     expect(resultItems[0].link).toBeUndefined();
//     expect(resultItems[0].dateObject).toBeNull();
//   });

//   it('should skip rows where all cells are empty or whitespace', () => {
//     const values = [
//         ['', null, '   '],
//         ['Real Title', 'Desc']
//     ];
//     const resultItems = generateFeedAutoMode(values);
//     expect(resultItems.length).toBe(1);
//     expect(resultItems[0].title).toBe('Real Title');
//   });

//   // --- Date Handling Tests ---
//   it('should parse various date formats and sort correctly', () => {
//     const dateEarlyStr = '04/01/2025';
//     const dateMidStr = '2025-04-02T15:00:00Z';
//     const dateLateStr = 'Wed, 02 Apr 2025 18:30:00 GMT';

//     const values = [
//       ['Title Mid', 'Desc Mid', dateMidStr],
//       ['Title Early', 'Desc Early', dateEarlyStr],
//       ['Title Late', 'Desc Late', dateLateStr],
//     ];

//     const resultItems = generateFeedAutoMode(values);

//     expect(resultItems.length).toBe(3);

//     // Check sorting: Late should be first, Early should be last
//     expect(resultItems[0].title).toBe('Title Late');
//     expect(resultItems[1].title).toBe('Title Mid');
//     expect(resultItems[2].title).toBe('Title Early');

//     // Check that dates were parsed correctly (compare timestamps)
//     // Note: Parsing '04/01/2025' might assume local time depending on helper implementation,
//     // but getTime() gives UTC milliseconds regardless, allowing comparison.
//     expect(resultItems[0].dateObject?.getTime()).toBe(new Date(dateLateStr).getTime());
//     expect(resultItems[1].dateObject?.getTime()).toBe(new Date(dateMidStr).getTime());
//     expect(resultItems[2].dateObject?.getTime()).toBe(new Date(dateEarlyStr).getTime());
//   });

//   it('should sort items with invalid/missing dates to the end', () => {
//     const dateValidStr = '2025-04-03T00:00:00Z';
//     const invalidDateStr = 'Not a valid date';

//     const values = [
//       ['Title Invalid Date', 'Desc Invalid', invalidDateStr],
//       ['Title Valid Date', 'Desc Valid', dateValidStr],
//       ['Title No Date', 'Desc No Date'],
//     ];

//     const resultItems = generateFeedAutoMode(values);

//     expect(resultItems.length).toBe(3);

//     expect(resultItems[0].title).toBe('Title Valid Date');
//     expect(resultItems[0].dateObject?.getTime()).toBe(new Date(dateValidStr).getTime());

//     expect(resultItems[1].dateObject).toBeNull();
//     expect(resultItems[2].dateObject).toBeNull();
//     const titlesAfterValid = [resultItems[1].title, resultItems[2].title];
//     expect(titlesAfterValid).toContain('Title Invalid Date');
//     expect(titlesAfterValid).toContain('Title No Date');
//   });
// });
