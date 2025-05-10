const { buildFeedData, generateRssFeed, generateAtomFeed, generateJsonFeedObject, generateMarkdown, escapeMarkdown, fetchUrlContent, parseXmlFeedWithCheerio, normalizeParsedFeed } = require('./helper');
const { format, formatISO, parseISO  } = require('date-fns');

// Define a fixed point in time for mocking 'now'
const MOCK_NOW_TIMESTAMP = new Date('2025-04-03T10:30:00.000Z').getTime();
const MOCK_NOW_DATE = new Date(MOCK_NOW_TIMESTAMP);

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
const mockSheetValuesManual = [
    ['Title', 'URL', 'Summary', 'Published', 'Category', 'Author Name'], // Headers with aliases and custom
    ['Manual Title 1', 'https://example.com/m1', 'Manual Desc 1', '2025-04-01T12:00:00Z', 'Tech', 'Alice'], // Earlier Date
    ['Manual Title 2', 'https://example.com/m2', 'Manual Desc 2 & Special', '2025-04-02T12:00:00Z', 'News', 'Bob'], // Later Date
    ['Manual Title 3 No Date', 'https://example.com/m3', 'Manual Desc 3', '', 'Tech', 'Charlie'], // No Date
];
// Mock data structure as returned by the updated getSheetData
const mockSingleSheetAutoData = { 'Sheet1': mockSheet1Values };
const mockSingleSheetManualData = { 'Sheet3': mockSheetValuesManual }; // Use Sheet3 name for clarity
const mockMultiSheetAutoData = {
    'Sheet1': mockSheet1Values,
    'Sheet2': mockSheet2Values
};
// Mock data specifically for testing missing title VALUE in manual mode
const mockSheetValuesManualNoTitleValue = [
    ['Link', 'Description', 'Title', 'pubDate'], // Headers, title is 3rd column (index 2)
    ['https://example.com/item1', 'Desc 1', 'Valid Title 1', '2025-04-01T12:00:00Z'], // Valid item
    ['https://example.com/item2', 'Desc 2', '', '2025-04-02T12:00:00Z'], // Item with empty title cell -> should become (Untitled)
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
            expect(feedData.metadata.description).toBe('Feed from Google Sheet (manual mode).'); // No sheet name here now
            expect(feedData.metadata.lastBuildDate.getTime()).toBe(parseISO('2025-04-02T12:00:00Z').getTime());
        });

        it('should return the correct number of item objects', () => {
            expect(Array.isArray(items)).toBe(true);
            expect(items.length).toBe(3); // Now includes item with no date
        });

        // Test name updated to reflect sorting
        it('should map aliases and custom headers to item properties (sorted)', () => {
            // Check sorting: Manual Title 2 (Apr 2nd) should be first
            expect(items[0].title).toBe('Manual Title 2');
            expect(items[0].link).toBe('https://example.com/m2'); // Mapped from 'URL' alias
            expect(items[0].descriptionContent).toBe('Manual Desc 2 & Special'); // Mapped from 'Summary' alias
            expect(items[0].dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z'); // Mapped from 'Published' alias
            expect(items[0].customFields).toBeDefined();
            expect(items[0].customFields['Category']).toBe('News'); // Custom field 'Category'
            expect(items[0].customFields['Author_Name']).toBe('Bob'); // Custom field 'Author Name' (sanitized)

            // Check second item
            expect(items[1].title).toBe('Manual Title 1');
            expect(items[1].dateObject?.toISOString()).toBe('2025-04-01T12:00:00.000Z');
            expect(items[1].customFields).toBeDefined();
            expect(items[1].customFields['Category']).toBe('Tech');
            expect(items[1].customFields['Author_Name']).toBe('Alice');

             // Check third item (no date, comes last)
             expect(items[2].title).toBe('Manual Title 3 No Date');
             expect(items[2].dateObject).toBeNull();
             expect(items[2].customFields).toBeDefined();
             expect(items[2].customFields['Category']).toBe('Tech');
             expect(items[2].customFields['Author_Name']).toBe('Charlie');
        });

         it('should handle missing date in manual mode', () => {
             // Use data that includes an item missing a date
             const feedDataNoDate = buildFeedData({ 'SheetX': mockSheetValuesManual }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
             // Find the specific item that should have a null date (it will be last after sorting)
             const item3 = feedDataNoDate.items[2];
             expect(item3.title).toBe('Manual Title 3 No Date');
             expect(item3.link).toBe('https://example.com/m3');
             expect(item3.descriptionContent).toBe('Manual Desc 3');
             expect(item3.dateObject).toBeNull(); // Date string was empty
        });

        it('should use placeholder title if title value is missing in manual mode', () => {
            const feedDataNoTitleValue = buildFeedData({ 'SheetX': mockSheetValuesManualNoTitleValue }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
            const itemsNoTitleValue = feedDataNoTitleValue.items;

            expect(itemsNoTitleValue).toHaveLength(3);
            // Items should be sorted by date descending (Apr 3, Apr 2, Apr 1)
            expect(itemsNoTitleValue[0].title).toBe('Valid Title 3'); // Apr 3rd
            expect(itemsNoTitleValue[1].title).toBe('(Untitled)'); // Apr 2nd (originally empty title)
            expect(itemsNoTitleValue[2].title).toBe('Valid Title 1'); // Apr 1st

            const itemWithPlaceholder = itemsNoTitleValue[1]; // Check the middle item
            expect(itemWithPlaceholder.title).toBe('(Untitled)');
            expect(itemWithPlaceholder.link).toBe('https://example.com/item2');
            expect(itemWithPlaceholder.descriptionContent).toBe('Desc 2');
            expect(itemWithPlaceholder.dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');
        });

        it('should use placeholder title if "title" header is missing in manual mode', () => {
            const feedDataNoTitleHeader = buildFeedData({ 'SheetX': mockSheetValuesManualNoTitleHeader }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
            const itemsNoTitleHeader = feedDataNoTitleHeader.items;

            expect(itemsNoTitleHeader).toHaveLength(2);
            // Items should be sorted by date descending (Apr 2nd, Apr 1st)
            expect(itemsNoTitleHeader[0].title).toBe('(Untitled)');
            expect(itemsNoTitleHeader[0].link).toBe('https://example.com/item2'); // Check other fields mapped
            expect(itemsNoTitleHeader[0].dateObject?.toISOString()).toBe('2025-04-02T12:00:00.000Z');

            expect(itemsNoTitleHeader[1].title).toBe('(Untitled)');
            expect(itemsNoTitleHeader[1].link).toBe('https://example.com/item1');
            expect(itemsNoTitleHeader[1].dateObject?.toISOString()).toBe('2025-04-01T12:00:00.000Z');
        });

        it('should skip rows where all cells are empty or whitespace in manual mode', () => {
             const feedDataEmptyRows = buildFeedData({ 'SheetX': mockSheetValuesManualEmptyRow }, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
             expect(feedDataEmptyRows.items).toHaveLength(2); // Only the two valid rows
             // Items should be sorted if manual sorting is enabled in helper
             expect(feedDataEmptyRows.items[0].title).toBe('Valid Title 1'); // No date, order might depend on stability
             expect(feedDataEmptyRows.items[1].title).toBe('Valid Title 2'); // No date
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

describe('generateJsonFeedObject (Helper Function)', () => {
    const mode = 'auto';
    // Use aggregated data for general structure
    const feedDataAggregated = buildFeedData(mockMultiSheetAutoData, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
    const resultJson = generateJsonFeedObject(feedDataAggregated);

    it('should contain correct top-level feed properties for aggregated data', () => {
        expect(resultJson.version).toBe('https://jsonfeed.org/version/1.1');
        expect(resultJson.title).toBe(mockSheetTitle); // XML escaping not relevant for JSON values
        expect(resultJson.home_page_url).toBe(`https://docs.google.com/spreadsheets/d/${mockSheetID}`);
        expect(resultJson.feed_url).toBe(mockRequestUrl);
        expect(resultJson.description).toBe('Feed from Google Sheet (auto mode).');
    });

    it('should contain the correct total number of items', () => {
        expect(Array.isArray(resultJson.items)).toBe(true);
        expect(resultJson.items.length).toBe(4); // Combined items
    });

    it('should contain correct properties for the latest item', () => {
        const firstItem = feedDataAggregated.items[0]; // Title 4 Latest (S2)
        const jsonItem = resultJson.items[0];

        expect(jsonItem.id).toBe(firstItem.link); // Link is used as ID
        expect(jsonItem.url).toBe(firstItem.link);
        expect(jsonItem.title).toBe(firstItem.title);
        expect(jsonItem.content_html).toBe(firstItem.descriptionContent);
        expect(jsonItem.date_published).toBe(formatISO(firstItem.dateObject));
    });

    it('should handle items with no link (generate hashed ID)', () => {
        // Find "Title 3 No Date (S1)" which has no link and no original date
        const itemNoLinkNoDate = feedDataAggregated.items.find(item => item.title === 'Title 3 No Date (S1)');
        const jsonItem = resultJson.items.find(jItem => jItem.title === 'Title 3 No Date (S1)');

        expect(jsonItem).toBeDefined();
        expect(itemNoLinkNoDate).toBeDefined();
        expect(jsonItem.url).toBeUndefined(); // No link, so no 'url'
        expect(jsonItem.title).toBe('Title 3 No Date (S1)');
        expect(jsonItem.content_html).toBe('Desc C');
        expect(jsonItem.id).toMatch(/^urn:google-sheet:TEST_SHEET_ID_123:[a-f0-9]{40}$/);
    });

    it('should include custom fields under _crssnt_custom_fields for manual mode', () => {
        const manualFeedData = buildFeedData(mockSingleSheetManualData, 'manual', 'Manual Sheet', 'MANUAL_ID', 'https://crssnt.com/manual');
        const manualJson = generateJsonFeedObject(manualFeedData);
        // Find "Manual Title 2" which has custom fields
        const itemWithCustom = manualJson.items.find(item => item.title === 'Manual Title 2');
        expect(itemWithCustom).toBeDefined();
        expect(itemWithCustom._crssnt_custom_fields).toBeDefined();
        expect(itemWithCustom._crssnt_custom_fields.Category).toBe('News');
        expect(itemWithCustom._crssnt_custom_fields.Author_Name).toBe('Bob'); // Sanitized from 'Author Name'
    });

    it('should include truncation notice in description if items are limited', () => {
        const limitedFeedData = buildFeedData(mockMultiSheetAutoData, 'auto', mockSheetTitle, mockSheetID, mockRequestUrl, 1, 500); // Limit to 1 item
        const limitedJson = generateJsonFeedObject(limitedFeedData);
        expect(limitedJson.description).toContain('Note: This feed may be incomplete due to configured limits.');
    });
});

describe('generateMarkdown (Helper Function)', () => {
    const mode = 'auto';
    const feedDataAggregated = buildFeedData(mockMultiSheetAutoData, mode, mockSheetTitle, mockSheetID, mockRequestUrl);
    const resultMd = generateMarkdown(feedDataAggregated);


    it('should contain the correct total number of items (indicated by separators)', () => {
        // Each item is followed by "\n---\n\n", plus one initial "---" after header
        const separatorCount = (resultMd.match(/\n---\n\n/g) || []).length;
        expect(separatorCount).toBe(feedDataAggregated.items.length + 1); // +1 for header separator
    });

    it('should contain correct content for the latest item', () => {
        const firstItem = feedDataAggregated.items[0]; // Title 4 Latest (S2)
        const expectedPublishedDate = format(firstItem.dateObject, 'PPPppp', { timeZone: 'GMT' });

        expect(resultMd).toContain(`## ${escapeMarkdown(firstItem.title)}`);
        expect(resultMd).toContain(`*Published: ${expectedPublishedDate} (GMT)*`);
        expect(resultMd).toContain(firstItem.descriptionContent);
    });

    it('should handle items with no link and no date correctly', () => {
        // "Title 3 No Date (S1)"
        const itemNoLinkNoDate = feedDataAggregated.items.find(item => item.title === 'Title 3 No Date (S1)');
        const expectedMarkdownTitle = escapeMarkdown(itemNoLinkNoDate.title);
        expect(resultMd).toContain(`## ${expectedMarkdownTitle}`);
        // Should not contain "Published:" line as dateObject is null
        expect(resultMd).not.toContain(`## ${expectedMarkdownTitle}\n\n*Published:`);
        // Should not contain "**Link:**" line as link is undefined
        const regexEscapedMarkdownTitle = expectedMarkdownTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const itemSectionRegex = new RegExp(`## ${regexEscapedMarkdownTitle}[\\s\\S]*?---`);
        const itemSectionMatch = resultMd.match(itemSectionRegex);
        expect(itemSectionMatch).toBeTruthy();
        expect(itemSectionMatch[0]).not.toContain("**Link:**");
        expect(resultMd).toContain(itemNoLinkNoDate.descriptionContent);
    });

    it('should include custom fields correctly for manual mode', () => {
        const manualFeedData = buildFeedData(mockSingleSheetManualData, 'manual', 'Manual Sheet', 'MANUAL_ID', 'https://crssnt.com/manual');
        const manualMd = generateMarkdown(manualFeedData);

        // Check for "Manual Title 2" which has custom fields
        const itemTitle2 = 'Manual Title 2';
        const escapedItemTitle2 = escapeMarkdown(itemTitle2); // Ensure title used in regex is escaped
        const regexEscapedItemTitle2 = escapedItemTitle2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const item2SectionRegex = new RegExp(`## ${regexEscapedItemTitle2}[\\s\\S]*?---`);
        const item2SectionMatch = manualMd.match(item2SectionRegex);
        expect(item2SectionMatch).toBeTruthy();
        const item2Md = item2SectionMatch[0];

        expect(item2Md).toContain(`**Custom Fields:**`); // This part is fine
        expect(item2Md).toContain(`* ${escapeMarkdown('Category')}: ${escapeMarkdown('News')}`);
        expect(item2Md).toContain(`* ${escapeMarkdown('Author_Name')}: ${escapeMarkdown('Bob')}`);
    });

    it('should include truncation notice if items are limited', () => {
        const limitedFeedData = buildFeedData(mockMultiSheetAutoData, 'auto', mockSheetTitle, mockSheetID, mockRequestUrl, 1, 500); // Limit to 1 item
        const limitedMd = generateMarkdown(limitedFeedData);
        expect(limitedMd).toContain(`**Note: This feed may be incomplete due to configured limits.**`);
    });

    it('should handle empty items list gracefully', () => {
        const emptyFeedData = {
            metadata: { title: 'Empty Feed', link: 'http://example.com', feedUrl: 'http://example.com/feed', description: 'An empty feed.' , lastBuildDate: MOCK_NOW_DATE, id:'urn:empty'},
            items: []
        };
        const md = generateMarkdown(emptyFeedData);
        expect(md).toContain("# Empty Feed");
        expect(md).toContain("_No items found._");
    });
});

// --- Mock XML Data for External Feed Parsing ---
const mockRssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Mock RSS Feed</title>
    <link>https://example.com/rss</link>
    <atom:link href="https://example.com/rss/feed.xml" rel="self" type="application/rss+xml" />
    <description>This is a mock RSS feed for testing.</description>
    <lastBuildDate>Tue, 02 Apr 2025 10:00:00 GMT</lastBuildDate>
    <language>en-US</language>
    <generator>TestGen RSS</generator>
    <item>
      <title>RSS Item 2 (Newer)</title>
      <link>https://example.com/rss/item2</link>
      <description><![CDATA[Description for <b>RSS</b> item 2.]]></description>
      <pubDate>Tue, 02 Apr 2025 10:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://example.com/rss/item2</guid>
    </item>
    <item>
      <title>RSS Item 1 (Older)</title>
      <link>https://example.com/rss/item1</link>
      <description>Description for RSS item 1.</description>
      <pubDate>Mon, 01 Apr 2025 09:00:00 GMT</pubDate>
      <guid isPermaLink="false">rss-item-1-guid</guid>
    </item>
    <item>
      <title>RSS Item 3 (No Date)</title>
      <link>https://example.com/rss/item3</link>
      <description>Description for RSS item 3.</description>
    </item>
  </channel>
</rss>`;

const mockAtomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="fr">
  <title>Mock Atom Feed</title>
  <subtitle>This is a mock Atom feed for testing.</subtitle>
  <link href="https://example.com/atom/feed.xml" rel="self"/>
  <link href="https://example.com/atom" rel="alternate"/>
  <id>urn:uuid:mock-atom-feed</id>
  <updated>2025-04-02T15:00:00Z</updated>
  <generator version="1.0" uri="https://example.com/atomgen">TestGen Atom</generator>
  <entry>
    <title>Atom Entry 2 (Newer)</title>
    <link href="https://example.com/atom/entry2" rel="alternate"/>
    <id>urn:uuid:atom-entry-2</id>
    <updated>2025-04-02T15:00:00Z</updated>
    <published>2025-04-02T14:50:00Z</published>
    <summary type="html"><![CDATA[Summary for <b>Atom</b> entry 2.]]></summary>
  </entry>
  <entry>
    <title>Atom Entry 1 (Older)</title>
    <link href="https://example.com/atom/entry1"/>
    <id>urn:uuid:atom-entry-1</id>
    <updated>2025-04-01T12:00:00Z</updated>
    <content type="text">Content for Atom entry 1.</content>
  </entry>
  <entry>
    <title>Atom Entry 3 (No Date)</title>
    <link href="https://example.com/atom/entry3"/>
    <id>urn:uuid:atom-entry-3</id>
    <summary>Summary for Atom entry 3.</summary>
  </entry>
</feed>`;

const mockInvalidXml = `<data><value>Some random XML</value></data>`;
const mockMinimalRssNoDates = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Minimal Feed</title></channel></rss>`;


describe('fetchUrlContent', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch; // Restore original fetch after each test
    });

    it('should fetch and return content for a successful response', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            text: async () => 'Mocked fetched content',
        });
        const content = await fetchUrlContent('https://example.com/feed.xml');
        expect(fetch).toHaveBeenCalledWith('https://example.com/feed.xml', { headers: { 'User-Agent': 'crssnt-feed-generator/1.0' } });
        expect(content).toBe('Mocked fetched content');
    });

    it('should throw an error for a non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        });
        await expect(fetchUrlContent('https://example.com/notfound.xml'))
            .rejects.toThrow('Failed to fetch https://example.com/notfound.xml: 404 Not Found');
    });

    it('should throw an error if fetch itself fails', async () => {
        global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network error'));
        await expect(fetchUrlContent('https://example.com/network-error.xml'))
            .rejects.toThrow('Network error');
    });
});

describe('parseXmlFeedWithCheerio', () => {
    it('should parse a valid XML string and return a Cheerio object', () => {
        const $ = parseXmlFeedWithCheerio(mockRssXml);
        expect($).toBeDefined();
        expect(typeof $.root).toBe('function'); // Basic check for Cheerio object
        expect($('rss > channel > title').text()).toBe('Mock RSS Feed');
    });
});

describe('normalizeParsedFeed', () => {
    const sourceUrl = 'https://example.com/source';

    describe('RSS Feed', () => {
        const $ = parseXmlFeedWithCheerio(mockRssXml);
        const feedData = normalizeParsedFeed($, sourceUrl);

        it('should extract correct RSS metadata', () => {
            expect(feedData.metadata.title).toBe('Mock RSS Feed');
            expect(feedData.metadata.link).toBe('https://example.com/rss');
            expect(feedData.metadata.feedUrl).toBe(sourceUrl);
            expect(feedData.metadata.description).toBe('This is a mock RSS feed for testing.');
            expect(feedData.metadata.lastBuildDate.toISOString()).toBe(parseISO('2025-04-02T10:00:00Z').toISOString()); // Newest item date
            expect(feedData.metadata.language).toBe('en-US');
            expect(feedData.metadata.generator).toBe('TestGen RSS');
            expect(feedData.metadata.id).toBe('https://example.com/rss/feed.xml');
        });

        it('should extract and sort RSS items correctly', () => {
            expect(feedData.items).toHaveLength(3);
            expect(feedData.items[0].title).toBe('RSS Item 2 (Newer)');
            expect(feedData.items[0].link).toBe('https://example.com/rss/item2');
            expect(feedData.items[0].descriptionContent).toBe('Description for <b>RSS</b> item 2.');
            expect(feedData.items[0].dateObject.toISOString()).toBe(parseISO('2025-04-02T10:00:00Z').toISOString());
            expect(feedData.items[0].id).toBe('https://example.com/rss/item2');

            expect(feedData.items[1].title).toBe('RSS Item 1 (Older)');
            expect(feedData.items[1].id).toBe('rss-item-1-guid');

            expect(feedData.items[2].title).toBe('RSS Item 3 (No Date)');
            expect(feedData.items[2].dateObject).toBeNull();
        });
    });

    describe('Atom Feed', () => {
        const $ = parseXmlFeedWithCheerio(mockAtomXml);
        const feedData = normalizeParsedFeed($, sourceUrl);

        it('should extract correct Atom metadata', () => {
            expect(feedData.metadata.title).toBe('Mock Atom Feed');
            expect(feedData.metadata.link).toBe('https://example.com/atom');
            expect(feedData.metadata.feedUrl).toBe(sourceUrl);
            expect(feedData.metadata.description).toBe('This is a mock Atom feed for testing.');
            expect(feedData.metadata.lastBuildDate.toISOString()).toBe(parseISO('2025-04-02T15:00:00Z').toISOString()); // Newest item date
            expect(feedData.metadata.language).toBe('fr');
            expect(feedData.metadata.generator).toBe('TestGen Atom (https://example.com/atomgen)');
            expect(feedData.metadata.id).toBe('urn:uuid:mock-atom-feed');
        });

        it('should extract and sort Atom entries correctly', () => {
            expect(feedData.items).toHaveLength(3);
            expect(feedData.items[0].title).toBe('Atom Entry 2 (Newer)');
            expect(feedData.items[0].link).toBe('https://example.com/atom/entry2');
            expect(feedData.items[0].descriptionContent).toBe('Summary for <b>Atom</b> entry 2.');
            expect(feedData.items[0].dateObject.toISOString()).toBe(parseISO('2025-04-02T15:00:00Z').toISOString()); // from <updated>
            expect(feedData.items[0].id).toBe('urn:uuid:atom-entry-2');

            expect(feedData.items[1].title).toBe('Atom Entry 1 (Older)');
            expect(feedData.items[1].descriptionContent).toBe('Content for Atom entry 1.');

            expect(feedData.items[2].title).toBe('Atom Entry 3 (No Date)');
            expect(feedData.items[2].dateObject).toBeNull();
        });
    });

    it('should handle unknown feed type', () => {
        const $ = parseXmlFeedWithCheerio(mockInvalidXml);
        const feedData = normalizeParsedFeed($, sourceUrl);
        expect(feedData.metadata.title).toBe('Unknown Feed Type');
        expect(feedData.metadata.description).toContain('Could not determine feed type');
        expect(feedData.items).toHaveLength(0);
        expect(feedData.metadata.lastBuildDate.getTime()).toBe(MOCK_NOW_DATE.getTime()); // Fallback to MOCK_NOW_DATE
    });

    it('should use MOCK_NOW_DATE for lastBuildDate if no feed/item dates found', () => {
        const $ = parseXmlFeedWithCheerio(mockMinimalRssNoDates);
        const feedData = normalizeParsedFeed($, sourceUrl);
        expect(feedData.metadata.title).toBe('Minimal Feed');
        expect(feedData.items).toHaveLength(0);
        expect(feedData.metadata.lastBuildDate.getTime()).toBe(MOCK_NOW_DATE.getTime());
    });

    it('should limit items based on itemLimit', () => {
        const $ = parseXmlFeedWithCheerio(mockRssXml);
        const feedData = normalizeParsedFeed($, sourceUrl, 1); // itemLimit = 1
        expect(feedData.items).toHaveLength(1);
        expect(feedData.items[0].title).toBe('RSS Item 2 (Newer)');
        expect(feedData.metadata.itemCountLimited).toBe(true);
    });

    it('should limit description length based on charLimit', () => {
        const $ = parseXmlFeedWithCheerio(mockRssXml);
        // "Description for <b>RSS</b> item 2." is 32 chars
        const feedData = normalizeParsedFeed($, sourceUrl, Infinity, 10); // charLimit = 10
        expect(feedData.items[0].descriptionContent).toBe('Descriptio...');
        expect(feedData.metadata.itemCharLimited).toBe(true);
    });

    it('should not mark charLimited if content is shorter than limit', () => {
        const $ = parseXmlFeedWithCheerio(mockRssXml);
        const feedData = normalizeParsedFeed($, sourceUrl, Infinity, 100); // charLimit = 100
        expect(feedData.items[0].descriptionContent).toBe('Description for <b>RSS</b> item 2.');
        expect(feedData.metadata.itemCharLimited).toBe(false); // Assuming other items are also short
    });
});