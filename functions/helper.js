const crypto = require('crypto');
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const { parseISO, isValid, format, formatISO } = require('date-fns');


// --- XML Escaping ---

function escapeXmlMinimal(unsafe) {
    if (typeof unsafe !== 'string') {
      return ''; // Return empty string for non-string input
    }
    return unsafe.replace(/[<>&"']/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '"': return '&quot;';
        case "'": return '&apos;';
      }
    });
  }
  

// --- Date Handling ---

function parseDateString(dateString) {
    if (!dateString || typeof dateString !== 'string') {
        console.error("parseDateString received invalid input:", dateString);
        return null;
    }

    let parsedDate = null;

    try {
        parsedDate = parseISO(dateString);
        if (isValid(parsedDate)) {
            return parsedDate;
        }
    } catch (e) { /* ignore */ }
    try {
        parsedDate = new Date(dateString);
        if (isValid(parsedDate)) {
            return parsedDate;
        }
    } catch(e) { /* ignore */ }

    return null;
}


function sortFeedItems(itemsData) {
    if (!Array.isArray(itemsData)) {
        console.error("sortFeedItems received non-array input:", itemsData);
        return;
    }

    itemsData.sort((a, b) => {
        const dateA = (a && a.dateObject instanceof Date && isValid(a.dateObject)) ? a.dateObject : null;
        const dateB = (b && b.dateObject instanceof Date && isValid(b.dateObject)) ? b.dateObject : null;

        // Logic to sort items with valid dates first, then items without dates.
        if (dateA && dateB) {
            // Both items have valid dates, sort descending (newest first)
            return dateB.getTime() - dateA.getTime();
        } else if (dateA) {
            // Only item A has a date, so A should come before B (which has no date)
            return -1;
        } else if (dateB) {
            // Only item B has a date, so B should come before A (which has no date)
            return 1;
        } else {
            // Neither item has a valid date, maintain their relative order
            return 0;
        }
    });
}

// --- Google Sheet Fetching ---

async function getSheetData(sheetID, sheetNames, apiKey) {
    const metaRequest = { spreadsheetId: sheetID, key: apiKey };
    const spreadsheetMeta = (await sheets.spreadsheets.get(metaRequest)).data;
    const sheetTitle = spreadsheetMeta.properties.title;

    let targetSheetNames = [];
    if (sheetNames === undefined || (Array.isArray(sheetNames) && sheetNames.length === 0)) {
        // Determine default sheet name if none provided
        const firstVisibleSheet = spreadsheetMeta.sheets.find(s => !s.properties.hidden);
        targetSheetNames = firstVisibleSheet ? [firstVisibleSheet.properties.title] : ['Sheet1'];
        console.warn(`getSheetData: No sheet names provided for ID ${sheetID}, using default: '${targetSheetNames[0]}'.`);
    } else if (typeof sheetNames === 'string') {
        targetSheetNames = [sheetNames];
    } else { // Should be an array
        targetSheetNames = sheetNames;
    }

    const ranges = targetSheetNames.map(name => name);

    const valuesRequest = {
        spreadsheetId: sheetID,
        key: apiKey,
        ranges: ranges,
        majorDimension: 'ROWS'
    };
    const batchGetResponse = (await sheets.spreadsheets.values.batchGet(valuesRequest)).data;
    
    const sheetData = {};
    if (batchGetResponse.valueRanges) {
        batchGetResponse.valueRanges.forEach(valueRange => {
            // Extract sheet name from the range string (e.g., "Sheet1!A1:Z1000" -> "Sheet1")
            const rangeName = valueRange.range.split('!')[0].replace(/'/g, ''); // Remove quotes if present
            sheetData[rangeName] = valueRange.values || [];
        });
    } else {
         console.warn(`getSheetData: No valueRanges returned for Sheet ID ${sheetID}, Ranges: ${JSON.stringify(ranges)}`);
    }

    return { title: sheetTitle, sheetData: sheetData };
}


// --- Sheet Data Parsing ---

function parseSheetRowAutoMode(row) {
    if (!row || row.length === 0) return null;

    let title = '';
    let titleIndex = -1;
    for (let i = 0; i < row.length; i++) {
        const cellValue = String(row[i] || '').trim();
        if (cellValue !== '') {
            title = cellValue;
            titleIndex = i;
            break;
        }
    }
    if (titleIndex === -1) return null; // Skip row if no title found

    const remainingRowData = row.filter((_, index) => index !== titleIndex);
    let link = undefined;
    let dateObject = null;
    let descriptionContent = '';
    const potentialDescriptionCells = [];

    for (const cell of remainingRowData) {
        const cellString = String(cell || '');

        if (!link && cellString.startsWith('http')) {
            link = cellString;
            continue;
        }
        if (!dateObject) {
            const parsed = parseDateString(cellString);
            if (parsed instanceof Date && isValid(parsed)) {
                dateObject = parsed;
                continue;
            }
        }
        potentialDescriptionCells.push(cellString);
    }
    descriptionContent = potentialDescriptionCells.filter(s => s.trim() !== '').join(' ');

    return { title, link, dateObject, descriptionContent };
}


// --- Feed Generation ---

function generateItemData(values, mode) {
    let items = [];
    if (mode.toLowerCase() === 'manual') {
        items = generateFeedManualModeInternal(values);
        sortFeedItems(items);
    } else {
        items = values.map(row => parseSheetRowAutoMode(row)).filter(item => item !== null);
        sortFeedItems(items);
    }
    return items;
}

function generateFeedManualModeInternal(values) {
    const items = [];
    if (!values || values.length < 2) return items;
    const headers = values[0];
    const headerMap = {};
    headers.forEach((header, index) => {
        if (typeof header === 'string') headerMap[header.toLowerCase().trim()] = index;
    });
    const titleIndex = headerMap['title'];
    const linkIndex = headerMap['link'];
    const descriptionIndex = headerMap['description'];
    const dateIndex = headerMap['pubdate'] ?? headerMap['date'] ?? headerMap['published'];

    for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (row && row.length > 0) {
            const title = titleIndex !== undefined ? String(row[titleIndex] || '').trim() : '';
            const link = linkIndex !== undefined ? String(row[linkIndex] || '').trim() : undefined;
            const descriptionContent = descriptionIndex !== undefined ? String(row[descriptionIndex] || '') : '';
            const dateString = dateIndex !== undefined ? String(row[dateIndex] || '') : undefined;
            let dateObject = parseDateString(dateString);
            items.push({ title, link: link || undefined, dateObject, descriptionContent });
        }
    }
    return items;
}

function buildFeedData(sheetData, mode, sheetTitle, sheetID, requestUrl) {
    let allItems = [];
    let sheetNames = Object.keys(sheetData);

    for (const sheetName of sheetNames) {
        const values = sheetData[sheetName];
        // Pass the correct values array (including header if manual)
        const itemsFromSheet = generateItemData(values, mode);
        allItems = allItems.concat(itemsFromSheet);
    }

    sortFeedItems(allItems);

    const feedDescription = `Feed from Google Sheet (${mode} mode).`;
    const latestItemDate = allItems.length > 0 && allItems[0].dateObject instanceof Date && isValid(allItems[0].dateObject)
                           ? allItems[0].dateObject : new Date();

    const feedData = {
        metadata: {
            title: sheetTitle || 'Google Sheet Feed',
            link: `https://docs.google.com/spreadsheets/d/${sheetID}`,
            feedUrl: requestUrl,
            description: feedDescription,
            lastBuildDate: latestItemDate,
            generator: 'https://github.com/tgel0/crssnt',
            id: `urn:google-sheet:${sheetID}` // Used for Atom <id>
        },
        items: allItems
    };
    return feedData;
}


function generateRssItemXml(itemData) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject
                     : new Date();

    const pubDateString = format(itemDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });

    const titleCDATA = `<![CDATA[${itemData.title || ''}]]>`;
    const descriptionCDATA = `<![CDATA[${itemData.descriptionContent || ''}]]>`;
    const linkElement = itemData.link ? `<link>${escapeXmlMinimal(itemData.link)}</link>` : '';
    let guidElement;

    if (itemData.link) {
        guidElement = `<guid isPermaLink="true">${escapeXmlMinimal(itemData.link)}</guid>`;
    } else {
        // Fallback GUID using hash
        const stringToHash = `${itemData.title || ''}::${itemData.descriptionContent || ''}`;
        const fallbackGuid = crypto.createHash('sha1').update(stringToHash).digest('hex');
        guidElement = `<guid isPermaLink="false">${fallbackGuid}</guid>`;
    }

    return `<item>
                <title>${titleCDATA}</title>
                <description>${descriptionCDATA}</description>
                ${linkElement}
                ${guidElement}
                <pubDate>${pubDateString}</pubDate>
            </item>`;
}


function generateRssFeed(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
        console.error("Invalid feedData passed to generateRssFeed");
        // Return a minimal valid feed indicating an error
        return `<?xml version="1.0" encoding="UTF-8"?>
                <rss version="2.0">
                    <channel>
                        <title>Error Generating Feed</title>
                        <link>${escapeXmlMinimal(feedData?.metadata?.link || '')}</link>
                        <description>Could not generate feed due to invalid data.</description>
                    </channel>
                </rss>`;
    }

    const { metadata, items } = feedData;

    const lastBuildDate = (metadata.lastBuildDate instanceof Date && isValid(metadata.lastBuildDate))
                          ? metadata.lastBuildDate
                          : new Date();
    const lastBuildDateString = format(lastBuildDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });

    const itemXmlStrings = items.map(item => generateRssItemXml(item)).join('');
    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>    
                    <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
                    <channel>
                        <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>
                        <link>${escapeXmlMinimal(metadata.link || '')}</link>
                        ${metadata.feedUrl ? `<atom:link href="${escapeXmlMinimal(metadata.feedUrl)}" rel="self" type="application/rss+xml" />` : ''}
                        <description>${escapeXmlMinimal(metadata.description || '')}</description>
                        <lastBuildDate>${lastBuildDateString}</lastBuildDate>
                        ${metadata.generator ? `<generator>${escapeXmlMinimal(metadata.generator)}</generator>` : ''}
                        ${itemXmlStrings}
                    </channel>
                    </rss>`;

    return feedXml;
}

function generateAtomEntryXml(itemData, feedMetadata) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject : new Date();
    const updatedString = formatISO(itemDate);

    const title = itemData.title || 'Untitled Entry';
    const description = itemData.descriptionContent || '';
    const link = itemData.link;

    let entryId;
    const baseId = feedMetadata.id || feedMetadata.link || `urn:uuid:${crypto.createHash('sha1').update(feedMetadata.title || 'feed').digest('hex')}`; // Generate base URN if needed
    
    if (link && link.startsWith('http')) {
        entryId = link;
    } else {
        const stringToHash = `${title}::${description}::${updatedString}`;
        const hash = crypto.createHash('sha1').update(stringToHash).digest('hex');
        entryId = `${baseId}:${hash}`;
    }

    const titleElement = `<title>${escapeXmlMinimal(title)}</title>`;
    const idElement = `<id>${escapeXmlMinimal(entryId)}</id>`; //
    const updatedElement = `<updated>${updatedString}</updated>`;
    const linkElement = link ? `<link href="${escapeXmlMinimal(link)}" rel="alternate" />` : '';
    const contentElement = `<content type="html"><![CDATA[${description}]]></content>`;
    return `<entry>
                ${titleElement}
                ${idElement}
                ${updatedElement}
                ${linkElement}
                ${contentElement}
            </entry>`;
}

function generateAtomFeed(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
       console.error("Invalid feedData passed to generateAtomFeed");
       return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Error Generating Feed</title><updated>${formatISO(new Date())}</updated><id>urn:uuid:error</id></feed>`;
   }
   const { metadata, items } = feedData;

   const feedUpdatedDate = (metadata.lastBuildDate instanceof Date && isValid(metadata.lastBuildDate))
                         ? metadata.lastBuildDate : new Date();
   const feedUpdatedString = formatISO(feedUpdatedDate);

   const feedId = metadata.id || metadata.feedUrl || metadata.link || `urn:uuid:${crypto.createHash('sha1').update(metadata.title || 'untitled').digest('hex')}`;
   const entryXmlStrings = items.map(item => generateAtomEntryXml(item, metadata)).join('');

   const feedXml = `<?xml version="1.0" encoding="utf-8"?>
                    <feed xmlns="http://www.w3.org/2005/Atom">
                    <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>
                    ${metadata.description ? `<subtitle>${escapeXmlMinimal(metadata.description)}</subtitle>` : ''}
                    <link href="${escapeXmlMinimal(metadata.feedUrl || '')}" rel="self" type="application/atom+xml"/>
                    <link href="${escapeXmlMinimal(metadata.link || '')}" rel="alternate"/>
                    <id>${escapeXmlMinimal(feedId)}</id>
                    <updated>${feedUpdatedString}</updated>
                    ${metadata.generator ? `<generator uri="https://github.com/tgel0/crssnt">${escapeXmlMinimal(metadata.generator)}</generator>` : ''}
                    ${entryXmlStrings}
                    </feed>`;

   return feedXml;
}


module.exports = {
    getSheetData,
    buildFeedData,
    generateRssFeed,
    generateAtomFeed
};