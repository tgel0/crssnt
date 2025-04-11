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
const mockRequestUrl = 'https://crssnt.com/sheetToRss?id=TEST_SHEET_ID_123&name=Sheet1&name=Sheet2';

const mockSheet1Values = [
    // Auto mode data
    ['Title 1 (S1)', 'Desc A', 'https://example.com/1', '2025-04-02T09:00:00Z'], // Middle
    ['Title 3 No Date (S1)', 'Desc C'], // No date
];
const mockSheet2Values = [
    // Auto mode data
    ['Title 2 (S2)', 'Desc B', 'https://example.com/2', '2025-04-01T08:00:00Z'], // Earliest
    ['Title 4 Latest (S2)', 'Desc D', 'https://example.com/4', '2025-04-03T10:00:00Z'], // Latest
];
const mockSheet3ValuesManual = [ // Manual mode data
    ['title', 'link', 'description', 'pubDate'], // Headers
    ['Manual Title 1 (S3)', 'https://example.com/m1', 'Manual Desc 1', '2025-04-01T12:00:00Z'],
    ['Manual Title 2 (S3)', 'https://example.com/m2', 'Manual Desc 2', '2025-04-02T12:00:00Z'], // Latest manual
];

// Mock data structure as returned by the updated getSheetData
const mockSingleSheetAutoData = { 'Sheet1': mockSheet1Values };
const mockSingleSheetManualData = { 'Sheet3': mockSheet3ValuesManual }; // Use Sheet3 name for clarity
const mockMultiSheetAutoData = {
    'Sheet1': mockSheet1Values,
    'Sheet2': mockSheet2Values
};
// Mock data specifically for testing missing title VALUE in manual mode
const mockSheetValuesManualNoTitleValue = [
    ['Link', 'Description', 'Title', 'pubDate'], // Headers, title is 3rd column (index 2)
    ['https://example.com/item1', 'Desc 1', 'Valid Title 1', '2025-04-01T12:00:00Z'], // Valid item
    ['https://example.com/item2', 'Desc 2', '', '2025-04-02T12:00:00Z'], // Item with empty title cell
    ['https://example.com/item3', 'Desc 3', 'Valid Title 3', '2025-04-03T12:00:00Z'] // Another valid item
];
// Mock data for testing missing title HEADER in manual mode
const mockSheetValuesManualNoTitleHeader = [
    ['Link', 'Description', 'NotTheTitle', 'pubDate'], // NO 'title' header
    ['https://example.com/item1', 'Desc 1', 'Some Value 1', '2025-04-01T12:00:00Z'],
    ['https://example.com/item2', 'Desc 2', 'Some Value 2', '2025-04-02T12:00:00Z']
];
// Mock data for testing empty rows in manual mode
const mockSheetValuesManualEmptyRow = [
    ['Title', 'Link'], // Header
    ['Valid Title 1', 'https://example.com/1'],
    ['', null], // Empty row
    ['  ', ' '], // Whitespace row
    ['Valid Title 2', 'https://example.com/2'],
];


// --- Tests ---

describe('buildFeedData (Helper Function)', () => {

    describe('Auto Mode', () => {
        const mode = 'auto';
        const feedData = buildFeedData(mockSingleSheetAutoData, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
        const items = feedData.items;

        it('should return the correct metadata structure', () => {
            expect(feedData.metadata.title).toBe(mockSheetTitle);
            expect(feedData.metadata.link).toBe(`https://docs.google.com/spreadsheets/d/${mockSheetID}`);
            expect(feedData.metadata.feedUrl).toBe(mockRequestUrl);
            // Check description *without* sheet name
            expect(feedData.metadata.description).toBe('Feed from Google Sheet (auto mode).');
            expect(feedData.metadata.id).toBe(`urn:google-sheet:${mockSheetID}`);
            const expectedLatestDate = parseISO('2025-04-02T09:00:00Z'); // Latest from Sheet1
            expect(feedData.metadata.lastBuildDate.getTime()).toBe(expectedLatestDate.getTime());
        });

        it('should return the correct number of item objects', () => {
            expect(Array.isArray(items)).toBe(true);
            expect(items.length).toBe(2);
        });

        it('should sort items correctly by date (descending)', () => {
            expect(items[0].title).toBe('Title 1 (S1)'); // Apr 2nd
            expect(items[1].title).toBe('Title 3 No Date (S1)'); // No date comes last
        });
    });

    describe('Manual Mode (Assuming Items are Sorted)', () => {
        const mode = 'manual';
        const feedData = buildFeedData(mockSingleSheetManualData, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
        const items = feedData.items;

         it('should return the correct metadata structure', () => {
            expect(feedData.metadata.title).toBe(mockSheetTitle);
            expect(feedData.metadata.description).toBe('Feed from Google Sheet (manual mode).');
             expect(feedData.metadata.lastBuildDate.getTime()).toBe(parseISO('2025-04-02T12:00:00Z').getTime());
        });

        it('should return the correct number of item objects', () => {
            expect(Array.isArray(items)).toBe(true);
            expect(items.length).toBe(2);
        });

        // Test name updated to reflect sorting
        it('should map common headers to item properties (sorted)', () => {
            expect(items[0].title).toBe('Manual Title 2 (S3)');
            expect(items[0].link).toBe('https://example.com/m2');
            expect(items[0].descriptionContent).toBe('Manual Desc 2');
            expect(items[0].dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');

            // Check second item
            expect(items[1].title).toBe('Manual Title 1 (S3)');
            expect(items[1].dateObject?.toISOString()).toBe('2025-04-01T12:00:00.000Z');
        });

        it('should use placeholder title if title value is missing in manual mode', () => {
            const feedDataNoTitleValue = buildFeedData({ 'SheetX': mockSheetValuesManualNoTitleValue }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
            const itemsNoTitleValue = feedDataNoTitleValue.items;

            expect(itemsNoTitleValue).toHaveLength(3);
            // Items should be sorted by date descending (Apr 3, Apr 2, Apr 1)
            expect(itemsNoTitleValue[0].title).toBe('Valid Title 3'); // Apr 3rd
            expect(itemsNoTitleValue[1].title).toBe(''); // Apr 2nd (originally empty title)
            expect(itemsNoTitleValue[2].title).toBe('Valid Title 1'); // Apr 1st

            const itemWithPlaceholder = itemsNoTitleValue[1]; // Check the middle item
            expect(itemWithPlaceholder.title).toBe('');
            expect(itemWithPlaceholder.link).toBe('https://example.com/item2');
            expect(itemWithPlaceholder.descriptionContent).toBe('Desc 2');
            expect(itemWithPlaceholder.dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');
        });

        it('should use placeholder title if "title" header is missing in manual mode', () => {
            const feedDataNoTitleHeader = buildFeedData({ 'SheetX': mockSheetValuesManualNoTitleHeader }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
            const itemsNoTitleHeader = feedDataNoTitleHeader.items;

            expect(itemsNoTitleHeader).toHaveLength(2);
            // Items should be sorted by date descending (Apr 2nd, Apr 1st)
            expect(itemsNoTitleHeader[0].title).toBe('');
            expect(itemsNoTitleHeader[0].link).toBe('https://example.com/item2'); // Check other fields mapped
            expect(itemsNoTitleHeader[0].dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');

            expect(itemsNoTitleHeader[1].title).toBe('');
            expect(itemsNoTitleHeader[1].link).toBe('https://example.com/item1');
            expect(itemsNoTitleHeader[1].dateObject?.toISOString()).toBe('2025-04-01T12:00:00.000Z');
        });

        it('should skip rows where all cells are empty or whitespace in manual mode', () => {
             const feedDataEmptyRows = buildFeedData({ 'SheetX': mockSheetValuesManualEmptyRow }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
             expect(feedDataEmptyRows.items).toHaveLength(4);
             // Items should be sorted if manual sorting is enabled in helper
             expect(feedDataEmptyRows.items[0].title).toBe('Valid Title 1'); // Assuming no date, original order kept
             expect(feedDataEmptyRows.items[3].title).toBe('Valid Title 2');
        });
    });

    describe('Sheet Tab Aggregation - Auto Mode', () => {
        const mode = 'auto';
        const feedData = buildFeedData(mockMultiSheetAutoData, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
        const items = feedData.items;

        it('should return combined metadata', () => {
            expect(feedData.metadata.title).toBe(mockSheetTitle);
            // Check description *without* sheet names
            expect(feedData.metadata.description).toBe('Feed from Google Sheet (auto mode).');
            const expectedLatestDate = parseISO('2025-04-03T10:00:00Z'); // From Sheet2
            expect(feedData.metadata.lastBuildDate.getTime()).toBe(expectedLatestDate.getTime());
        });

        it('should return the combined number of items from all sheets', () => {
             expect(Array.isArray(items)).toBe(true);
             expect(items.length).toBe(4);
        });

        it('should sort the COMBINED list of items correctly by date (descending)', () => {
            expect(items[0].title).toBe('Title 4 Latest (S2)'); // Apr 3 10:00 (Sheet2)
            expect(items[1].title).toBe('Title 1 (S1)');         // Apr 2 09:00 (Sheet1)
            expect(items[2].title).toBe('Title 2 (S2)');         // Apr 1 08:00 (Sheet2)
            expect(items[3].title).toBe('Title 3 No Date (S1)'); // No Date (Sheet1) - comes last
        });
    });

});

describe('generateRssFeed (Helper Function with Aggregated Data)', () => {
    const feedData = buildFeedData(mockMultiSheetAutoData, 'auto', mockSheetTitle, mockSheetID, mockRequestUrl);
    const resultXml = generateRssFeed(feedData);

    it('should contain channel metadata reflecting aggregation', () => {
        expect(resultXml).toContain(`<title>Test Sheet &lt;Title&gt;</title>`);
        // Check description *without* sheet names
        expect(resultXml).toContain(`<description>Feed from Google Sheet (auto mode).</description>`);
        const expectedDate = format(feedData.metadata.lastBuildDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
        expect(resultXml).toContain(`<lastBuildDate>${expectedDate}</lastBuildDate>`); // Should be latest date overall (Apr 3rd)
    });

    it('should contain the correct total number of items', () => {
         expect(resultXml.match(/<item>/g)?.length).toBe(4); // Combined items
    });

     it('should contain the latest item first', () => {
        const firstItem = feedData.items[0]; // Title 4 Latest
        const expectedDate = format(firstItem.dateObject, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
        expect(resultXml).toContain(`<title><![CDATA[${firstItem.title}]]></title>`);
        expect(resultXml).toContain(`<pubDate>${expectedDate}</pubDate>`);
    });
});

describe('generateAtomFeed (Helper Function with Aggregated Data)', () => {
    const feedData = buildFeedData(mockMultiSheetAutoData, 'auto', mockSheetTitle, mockSheetID, mockRequestUrl);
    const resultXml = generateAtomFeed(feedData);

     it('should contain feed metadata reflecting aggregation', () => {
        expect(resultXml).toContain(`<title>Test Sheet &lt;Title&gt;</title>`);
        // Check description *without* sheet names
        expect(resultXml).toContain(`<subtitle>Feed from Google Sheet (auto mode).</subtitle>`);
        expect(resultXml).toContain(`<id>${feedData.metadata.id}</id>`);
        expect(resultXml).toContain(`<updated>${formatISO(feedData.metadata.lastBuildDate)}</updated>`); // Should be latest date overall (Apr 3rd)
    });

    it('should contain the correct total number of entries', () => {
         expect(resultXml.match(/<entry>/g)?.length).toBe(4); // Combined items
    });

     it('should contain the latest entry first', () => {
        const firstItem = feedData.items[0]; // Title 4 Latest
        const expectedDate = formatISO(firstItem.dateObject);
        const expectedId = firstItem.link;

        expect(resultXml).toContain('<entry>');
        expect(resultXml).toContain(`<title>${firstItem.title}</title>`);
        expect(resultXml).toContain(`<id>${expectedId}</id>`);
        expect(resultXml).toContain(`<updated>${expectedDate}</updated>`);
        expect(resultXml).toContain('</entry>');
    });
});