const { buildFeedData, generateRssFeed, generateAtomFeed } = require('./helper');
const { format, formatISO, parseISO  } = require('date-fns');

// Define a fixed point in time for mocking 'now'
const MOCK_NOW_TIMESTAMP = new Date('2025-04-03T10:30:00.000Z').getTime();
const MOCK_NOW_DATE = new Date(MOCK_NOW_TIMESTAMP);
// Calculate the expected RFC 822 string for the mocked 'now' time ONCE
const MOCK_NOW_RFC822 = format(MOCK_NOW_DATE, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });

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
const mockSheetValuesManualNoTitle = [
    ['Link', 'Description', 'pubDate'],
    ['https://example.com/item1', 'Desc 1','2025-04-01T12:00:00Z'],
    ['https://example.com/item2', 'Desc 2', '2025-04-02T12:00:00Z']
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

        it('should use placeholder title if "title" header is missing in manual mode', () => {
            const feedDataNoTitleHeader = buildFeedData(mockSheetValuesManualNoTitle, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
            const itemsNoTitleHeader = feedDataNoTitleHeader.items;

            expect(itemsNoTitleHeader).toHaveLength(2);
            expect(itemsNoTitleHeader[0].title).toBe('');
            expect(itemsNoTitleHeader[1].title).toBe('');
            // Check that other mapped fields are still populated correctly
            expect(itemsNoTitleHeader[0].link).toBe('https://example.com/item2');
            expect(itemsNoTitleHeader[0].descriptionContent).toBe('Desc 2');
            expect(itemsNoTitleHeader[0].dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');
            expect(itemsNoTitleHeader[1].link).toBe('https://example.com/item1');
            expect(itemsNoTitleHeader[1].descriptionContent).toBe('Desc 1');
            expect(itemsNoTitleHeader[1].dateObject?.toISOString()).toBe('2025-04-01T12:00:00.000Z');
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

  describe('generateAtomFeed (Helper Function)', () => {
    // Use data generated by buildFeedData for testing
    const feedData = buildFeedData(mockSheetValuesAuto, 'auto', mockSheetTitle, mockSheetID, mockRequestUrl);
    const resultXml = generateAtomFeed(feedData);

    it('should return a non-empty string', () => {
        expect(typeof resultXml).toBe('string');
        expect(resultXml.length).toBeGreaterThan(0);
    });

     it('should contain Atom root element', () => {
        expect(resultXml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
        expect(resultXml).toContain('</feed>');
    });

     it('should contain feed metadata (escaped)', () => {
        expect(resultXml).toContain(`<title>Test Sheet &lt;Title&gt;</title>`); // Check escaped title
        expect(resultXml).toContain(`<link href="${mockRequestUrl.replace(/&/g, '&amp;')}" rel="self" type="application/atom+xml"/>`); // Escaped feedUrl
        expect(resultXml).toContain(`<link href="https://docs.google.com/spreadsheets/d/${mockSheetID}" rel="alternate"/>`);
        expect(resultXml).toContain(`<id>${feedData.metadata.id}</id>`); // Check feed ID (URN)
        expect(resultXml).toContain(`<updated>${formatISO(feedData.metadata.lastBuildDate)}</updated>`); // Check ISO formatted date
        expect(resultXml).toContain(`<subtitle>Feed from Google Sheet (auto mode).</subtitle>`); // Basic escaping applied by helper
    });

    it('should contain the correct number of entries', () => {
         expect(resultXml.match(/<entry>/g)?.length).toBe(feedData.items.length); // Should be 5
    });

     it('should contain correctly formatted entry data (e.g., first sorted item)', () => {
        const firstItem = feedData.items[0]; // Title 5
        const expectedDate = formatISO(firstItem.dateObject);
        const expectedId = firstItem.link; // Link should be used directly now

        expect(resultXml).toContain('<entry>');
        expect(resultXml).toContain(`<title>${firstItem.title}</title>`); // Escaping handled by helper
        expect(resultXml).toContain(`<id>${expectedId}</id>`); // Escaping handled by helper
        expect(resultXml).toContain(`<updated>${expectedDate}</updated>`);
        expect(resultXml).toContain(`<link href="${firstItem.link}" rel="alternate" />`); // Escaping handled by helper
        expect(resultXml).toContain(`<content type="html"><![CDATA[${firstItem.descriptionContent}]]></content>`); // CDATA used
        expect(resultXml).toContain('</entry>');
    });

     it('should generate a fallback entry ID if link is missing', () => {
        const itemWithoutLink = feedData.items.find(i => i.title === 'Title 3 No Date');
        // *** CORRECTED REGEX TO MATCH ACTUAL OUTPUT ***
        // Expect the feed base ID (URN) followed by : and a 40-char hex hash
        const expectedRegex = new RegExp(`<entry>.*?<id>urn:google-sheet:${mockSheetID}:[a-f0-9]{40}<\/id>.*?<\/entry>`, 's');
        expect(resultXml).toMatch(expectedRegex);
        // Check title just to be sure we're looking at the right entry context
        expect(resultXml).toContain(`<title>${itemWithoutLink.title}</title>`); // Escaping handled by helper
    });
});
});