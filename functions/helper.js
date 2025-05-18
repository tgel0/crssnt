const crypto = require('crypto');
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const { parseISO, isValid, format, formatISO } = require('date-fns');
const cheerio = require('cheerio'); // For parsing external XML feeds


// --- XML/Markdown Escaping ---

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

function escapeMarkdown(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/([\\`*_{}[\]()#+.!-])/g, '\\$1') // Escape markdown syntax characters
        .replace(/&/g, '&amp;') // Escape HTML entities that might still be interpreted
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
  

// --- Date Handling ---

function parseDateString(dateString) {
    if (!dateString || typeof dateString !== 'string') {
        // console.error("parseDateString received invalid input:", dateString); // Keep console logging minimal
        return null;
    }

    let parsedDate = null;

    try {
        parsedDate = parseISO(dateString);
        if (isValid(parsedDate)) {
            return parsedDate;
        }
    } catch (e) { /* ignore */ }
    
    // Fallback to generic Date constructor (less reliable for ambiguous formats)
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

        if (dateA && dateB) {
            return dateB.getTime() - dateA.getTime(); // Newest first
        } else if (dateA) {
            return -1; // dateA is valid, dateB is not, so A comes first
        } else if (dateB) {
            return 1;  // dateB is valid, dateA is not, so B comes first
        } else {
            return 0;  // Neither has a valid date, maintain original order relative to each other
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
        const firstVisibleSheet = spreadsheetMeta.sheets.find(s => !s.properties.hidden);
        targetSheetNames = firstVisibleSheet ? [firstVisibleSheet.properties.title] : ['Sheet1'];
        // console.warn(`getSheetData: No sheet names provided for ID ${sheetID}, using default: '${targetSheetNames[0]}'.`);
    } else if (typeof sheetNames === 'string') {
        targetSheetNames = [sheetNames];
    } else { 
        targetSheetNames = sheetNames;
    }

    const ranges = targetSheetNames.map(name => name); // Actual sheet names are valid ranges

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
            const rangeName = valueRange.range.split('!')[0].replace(/'/g, ''); 
            sheetData[rangeName] = valueRange.values || [];
        });
    } else {
         // console.warn(`getSheetData: No valueRanges returned for Sheet ID ${sheetID}, Ranges: ${JSON.stringify(ranges)}`);
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
            try {
                new URL(cellString); // Validate if it's a proper URL
                link = cellString;
                continue;
            } catch (e) { /* not a valid URL, might be description */ }
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
    descriptionContent = potentialDescriptionCells.filter(s => String(s || '').trim() !== '').join(' ');

    return { title, link, dateObject, descriptionContent };
}


// --- Feed Generation ---

function generateItemData(values, mode) {
    let items = [];
    if (mode.toLowerCase() === 'manual') {
        items = generateFeedManualModeInternal(values);
        // Sorting is now done after aggregation in buildFeedData or processMultipleUrls
    } else {
        items = values.map(row => parseSheetRowAutoMode(row)).filter(item => item !== null);
        // Sorting is now done after aggregation
    }
    return items;
}

function generateFeedManualModeInternal(values) {
    const items = [];
    if (!values || values.length < 2) return items;
    const headers = values[0];
    const headerMap = {};
    const customHeaderMap = {};
    const standardFieldAliases = {
        title: ['title'],
        link: ['link', 'url', 'uri', 'href'],
        description: ['description', 'desc', 'summary', 'content', 'content:encoded'],
        dateObject: ['pubdate', 'date', 'published', 'updated', 'timestamp', 'created']
    };

    headers.forEach((header, index) => {
        if (typeof header !== 'string' || header.trim() === '') return;
        const lowerHeader = header.toLowerCase().trim();
        let foundStandard = false;
        for (const standardField in standardFieldAliases) {
            if (standardFieldAliases[standardField].includes(lowerHeader)) {
                if (headerMap[standardField] === undefined) { // Take the first mapped alias
                    headerMap[standardField] = index;
                }
                foundStandard = true;
                break;
            }
        }
        if (!foundStandard) {
            customHeaderMap[header.trim()] = index; // Use original (trimmed) header for custom fields
        }
    });

    const titleIndex = headerMap['title']; // May be undefined if no title header
    const linkIndex = headerMap['link'];
    const descriptionIndex = headerMap['description'];
    const dateIndex = headerMap['dateObject'];

    for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (!row || row.every(cell => String(cell || '').trim() === '')) continue; // Skip empty/whitespace-only rows

        let title = titleIndex !== undefined ? String(row[titleIndex] || '').trim() : '';
        if (title === '') title = '(Untitled)'; // Placeholder if title column exists but cell is empty

        const link = linkIndex !== undefined ? String(row[linkIndex] || '').trim() : undefined;
        const descriptionContent = descriptionIndex !== undefined ? String(row[descriptionIndex] || '') : '';
        const dateString = dateIndex !== undefined ? String(row[dateIndex] || '') : undefined;
        let dateObject = parseDateString(dateString);

        const customFields = {};
        for (const originalCustomHeader in customHeaderMap) {
            const customIndex = customHeaderMap[originalCustomHeader];
            const customValue = row[customIndex] || '';
            if (String(customValue).trim() !== '') {
                const tagName = originalCustomHeader.replace(/[^a-zA-Z0-9_:-]/g, '_').replace(/^[^a-zA-Z_:]/, '_');
                if (tagName) {
                    customFields[tagName] = String(customValue);
                }
            }
        }

        items.push({
             title,
             link: link || undefined,
             dateObject, // Can be null
             descriptionContent,
             customFields: Object.keys(customFields).length > 0 ? customFields : undefined // Add only if non-empty
        });
    }
    return items;
}

function buildFeedData(sheetData, mode, sheetTitle, sheetID, requestUrl, itemLimit = 50, charLimit = 500) {
    let allItems = [];
    let sheetNames = Object.keys(sheetData);

    for (const sheetName of sheetNames) {
        const values = sheetData[sheetName];
        const itemsFromSheet = generateItemData(values, mode); // generateItemData no longer sorts
        allItems = allItems.concat(itemsFromSheet);
    }

    sortFeedItems(allItems); // Sort all combined items from sheets

    let itemCountLimited = false;
    let itemCharLimited = false;
    let limitedItems = allItems;

    if (allItems.length > itemLimit) {
        limitedItems = allItems.slice(0, itemLimit);
        itemCountLimited = true;
    }

    limitedItems = limitedItems.map(item => {
        const desc = String(item.descriptionContent || '');
        if (desc.length > charLimit) {
            item.descriptionContent = desc.slice(0, charLimit) + '...';
            itemCharLimited = true;
        }
        return item;
    });

    const latestItemDate = limitedItems.length > 0 && limitedItems[0].dateObject instanceof Date && isValid(limitedItems[0].dateObject)
        ? limitedItems[0].dateObject
        : new Date(); // Fallback to now
    
    const feedDescription = `Feed from Google Sheet (${mode} mode). Generated by crssnt.`;

    return {
        metadata: {
            title: sheetTitle || 'Google Sheet Feed',
            link: `https://docs.google.com/spreadsheets/d/${sheetID}`,
            feedUrl: requestUrl,
            description: feedDescription,
            lastBuildDate: latestItemDate,
            generator: 'https://github.com/tgel0/crssnt',
            id: `urn:google-sheet:${sheetID}`,
            itemCountLimited: itemCountLimited,
            itemCharLimited: itemCharLimited
        },
        items: limitedItems
    };
}

// --- External Feed Fetching & Parsing ---

async function fetchUrlContent(url) {
    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'crssnt-feed-generator/1.0 (+https://crssnt.com)' }});
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }
        const textContent = await response.text();
        return textContent;
    } catch (error) {
        // console.error(`fetchUrlContent: Error fetching ${url}:`, error.message);
        throw error;
    }
}

function parseXmlFeedWithCheerio(xmlString) {
    return cheerio.load(xmlString, {
        xmlMode: true,
        decodeEntities: true 
    });
}

function normalizeParsedFeed($, sourceUrl, itemLimit = Infinity, charLimit = Infinity) {
    const items = [];
    let feedTitle = '';
    let feedLink = '';
    let feedDescription = '';
    let feedLastBuildDate = null;
    let feedLanguage = 'en';
    let feedGenerator = 'crssnt (converted)';
    let feedId = sourceUrl;

    const _stripCdataWrapper = (str) => {
        const s = String(str || '');
        if (s.startsWith('<![CDATA[') && s.endsWith(']]>')) {
            return s.substring(9, s.length - 3);
        }
        return s;
    };

    const isRss = $('rss').length > 0;
    const isAtom = !isRss && $('feed').length > 0;
    let sourceType = 'unknown';

    if (isRss) {
        sourceType = 'rss';
        const channel = $('rss > channel').first();
        feedTitle = channel.find('> title').first().text().trim();
        feedLink = channel.find('> link').first().text().trim();
        feedDescription = _stripCdataWrapper(channel.find('> description').first().text().trim());
        feedLanguage = channel.find('> language').first().text().trim() || 'en';
        feedGenerator = channel.find('> generator').first().text().trim() || feedGenerator;
        const lastBuildDateStr = channel.find('> lastBuildDate').first().text().trim();
        if (lastBuildDateStr) feedLastBuildDate = parseDateString(lastBuildDateStr);
        const atomLinkSelf = channel.find('atom\\:link[rel="self"]').attr('href');
        feedId = atomLinkSelf || feedLink || sourceUrl;

        channel.find('item').each((i, el) => {
            const $item = $(el);
            const title = $item.find('> title').text().trim() || '(Untitled)';
            const link = $item.find('> link').text().trim() || $item.find('guid[isPermaLink="true"]').text().trim() || undefined;
            const rawDescription = $item.find('> description').html() || $item.find('content\\:encoded').html() || ''; // Prefer content:encoded
            const descriptionContent = _stripCdataWrapper(rawDescription);
            const pubDateStr = $item.find('> pubDate').text().trim();
            const dateObject = parseDateString(pubDateStr);
            const guid = $item.find('> guid').text().trim() || link; // Use link as fallback for ID
            // Add sourceInfo to each item
            items.push({ title, link, dateObject, descriptionContent, id: guid, sourceInfo: { title: feedTitle, url: sourceUrl, type: 'rss' } });
        });
    } else if (isAtom) {
        sourceType = 'atom';
        const feed = $('feed').first();
        feedTitle = feed.find('> title').first().text().trim();
        feedLink = feed.find('> link[rel="alternate"]').first().attr('href') || feed.find('> link').first().attr('href');
        feedDescription = _stripCdataWrapper(feed.find('> subtitle').first().text().trim());
        feedId = feed.find('> id').first().text().trim() || sourceUrl;
        const updatedStr = feed.find('> updated').first().text().trim();
        if (updatedStr) feedLastBuildDate = parseDateString(updatedStr);
        feedLanguage = feed.attr('xml:lang') || feed.find('> language').text().trim() || 'en'; // Atom can have xml:lang
        const generatorNode = feed.find('generator').first();
        feedGenerator = generatorNode.text().trim() || feedGenerator;
        if (generatorNode.attr('uri')) feedGenerator += ` (${generatorNode.attr('uri')})`;

        feed.find('entry').each((i, el) => {
            const $entry = $(el);
            const title = $entry.find('> title').text().trim() || '(Untitled)';
            const link = $entry.find('> link[rel="alternate"]').attr('href') || $entry.find('> link').first().attr('href');
            const rawDescription = $entry.find('> content').html() || $entry.find('> summary').html() || ''; // Prefer content over summary
            const descriptionContent = _stripCdataWrapper(rawDescription);
            const updatedStrEntry = $entry.find('> updated').text().trim() || $entry.find('> published').text().trim(); // Prefer updated
            const dateObject = parseDateString(updatedStrEntry);
            const id = $entry.find('> id').text().trim() || link;
            // Add sourceInfo to each item
            items.push({ title, link, dateObject, descriptionContent, id, sourceInfo: { title: feedTitle, url: sourceUrl, type: 'atom' } });
        });
    } else {
        feedTitle = "Unknown or Invalid Feed Type";
        feedDescription = `Could not determine feed type (RSS or Atom) for URL: ${sourceUrl}. Please ensure it's a valid XML feed.`;
    }

    sortFeedItems(items); // Sort items from this individual feed

    let itemCountLimited = false;
    let itemCharLimited = false;
    let limitedItems = items;

    if (itemLimit !== Infinity && items.length > itemLimit) {
        limitedItems = items.slice(0, itemLimit);
        itemCountLimited = true;
    }
    if (charLimit !== Infinity) {
        limitedItems = limitedItems.map(item => {
            const desc = String(item.descriptionContent || '');
            if (desc.length > charLimit) {
                item.descriptionContent = desc.slice(0, charLimit) + '...';
                itemCharLimited = true;
            }
            return item;
        });
    }
    
    // If feedLastBuildDate is still null, try to derive from the latest item (after individual sort and limit)
    if (!feedLastBuildDate && limitedItems.length > 0 && limitedItems[0].dateObject) {
        feedLastBuildDate = limitedItems[0].dateObject;
    }


    return {
        metadata: {
            title: feedTitle || 'Untitled Parsed Feed',
            link: feedLink || sourceUrl, // Link to original site
            feedUrl: sourceUrl,        // The URL of the feed itself
            description: feedDescription,
            lastBuildDate: feedLastBuildDate, // Can be null if no dates found
            language: feedLanguage,
            generator: feedGenerator,
            id: feedId, // Unique ID for the feed
            itemCountLimited,
            itemCharLimited,
            sourceType // Added sourceType
        },
        items: limitedItems // These items now include sourceInfo
    };
}

async function processMultipleUrls(sourceUrls, requestUrl, itemLimit = 50, charLimit = 500, groupByFeed = false) {
    let allItems = [];
    const allFeedMetadata = []; // Store metadata from each successfully fetched feed

    for (const sourceUrl of sourceUrls) {
        try {
            // console.log(`Processing URL: ${sourceUrl}`);
            const xmlString = await fetchUrlContent(sourceUrl);
            const $ = parseXmlFeedWithCheerio(xmlString);
            // Fetch all items from each feed initially by passing Infinity for itemLimit.
            // Character limit can be applied here if desired, or globally later.
            // For grouping, we want all items from each source before global limiting.
            const individualFeedData = normalizeParsedFeed($, sourceUrl, Infinity, charLimit); 

            if (individualFeedData && individualFeedData.items && individualFeedData.metadata.sourceType !== 'unknown') {
                // Items from normalizeParsedFeed already have sourceInfo attached
                allItems = allItems.concat(individualFeedData.items);
                allFeedMetadata.push(individualFeedData.metadata); 
            } else if (individualFeedData && individualFeedData.metadata.sourceType === 'unknown') {
                console.warn(`Skipping unknown feed type from ${sourceUrl}: ${individualFeedData.metadata.title}`);
            }
        } catch (error) {
            console.warn(`Failed to process URL ${sourceUrl}: ${error.message}. Skipping this source.`);
        }
    }

    if (allItems.length === 0) { 
        throw new Error('No valid feed items could be fetched or processed from the provided URLs.');
    }

    // If not grouping by feed, sort all items globally.
    // If grouping, sorting is implicitly handled by processing feeds sequentially and then applying limits.
    // The output functions will handle presentation order for grouped items.
    if (!groupByFeed) {
        sortFeedItems(allItems); 
    }
    // Note: If groupByFeed is true, items are already "grouped" by being concatenated in order of sourceUrls.
    // The output functions (JSON, Markdown) will use this order and sourceInfo.

    let itemCountLimited = false;
    let itemCharLimited = false; // This was already handled by normalizeParsedFeed if charLimit wasn't Infinity
    let limitedItems = allItems;

    if (allItems.length > itemLimit) {
        limitedItems = allItems.slice(0, itemLimit);
        itemCountLimited = true;
    }

    // Character limit was applied per-feed in normalizeParsedFeed if charLimit was not Infinity.
    // If charLimit was Infinity there, it means we apply it globally now (though less efficient).
    // For simplicity, we assume charLimit was passed down or we re-apply if needed.
    // The current normalizeParsedFeed applies charLimit, so this might be redundant if charLimit is passed.
    // However, if charLimit was Infinity in normalizeParsedFeed, this is the place.
    limitedItems = limitedItems.map(item => {
        const desc = String(item.descriptionContent || '');
        if (desc.length > charLimit) { // Re-check or apply if not done before
            item.descriptionContent = desc.slice(0, charLimit) + '...';
            itemCharLimited = true; // Set global flag if any item was truncated
        }
        return item;
    });
    
    // Construct combined metadata
    const firstValidMetadata = allFeedMetadata.length > 0 ? allFeedMetadata[0] : {};
    const combinedTitle = allFeedMetadata.length > 1 
        ? `Combined Feed from ${allFeedMetadata.length} sources` 
        : (firstValidMetadata.title || 'Combined Feed');
    
    const combinedLink = requestUrl; // The crssnt URL that generated this combined feed
    const combinedId = `urn:crssnt:combined:${crypto.createHash('sha1').update(sourceUrls.join(',')).digest('hex')}`;
    
    // Determine lastBuildDate: if grouped, it's the latest of all feed's lastBuildDates.
    // If not grouped, it's the date of the newest item in the combined list.
    let overallLastBuildDate;
    if (groupByFeed && allFeedMetadata.length > 0) {
        overallLastBuildDate = allFeedMetadata.reduce((latest, meta) => {
            if (meta.lastBuildDate && (!latest || meta.lastBuildDate.getTime() > latest.getTime())) {
                return meta.lastBuildDate;
            }
            return latest;
        }, null) || new Date();
    } else {
         overallLastBuildDate = limitedItems.length > 0 && limitedItems[0].dateObject instanceof Date && isValid(limitedItems[0].dateObject)
            ? limitedItems[0].dateObject
            : new Date(); 
    }


    let combinedFeedDescription = allFeedMetadata.length > 1
        ? `A combined feed generated from ${allFeedMetadata.length} sources via crssnt.`
        : (firstValidMetadata.description || `Feed generated from ${firstValidMetadata.feedUrl || 'source'} via crssnt.`);

    return {
        metadata: {
            title: combinedTitle,
            link: combinedLink, 
            feedUrl: requestUrl, 
            description: combinedFeedDescription,
            lastBuildDate: overallLastBuildDate,
            generator: 'https://github.com/tgel0/crssnt (combined)',
            id: combinedId,
            itemCountLimited: itemCountLimited,
            itemCharLimited: itemCharLimited, // Reflects if any item's char limit was hit
            language: firstValidMetadata.language || 'en',
            groupByFeed: groupByFeed && sourceUrls.length > 1 // Store the effective grouping status
        },
        items: limitedItems // Items will have sourceInfo attached
    };
}


// --- Feed Output Generation ---

function generateCustomFieldsXml(customFields) {
    if (!customFields || typeof customFields !== 'object') {
        return '';
    }
    let customXml = '';
    for (const tagName in customFields) {
        if (tagName && typeof customFields[tagName] === 'string') {
            customXml += `<${tagName}>${escapeXmlMinimal(customFields[tagName])}</${tagName}>\n      `;
        }
    }
    return customXml.trimEnd(); 
}


function generateRssItemXml(itemData) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject
                     : null; // Use null if no valid date

    const pubDateString = itemDate ? format(itemDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' }) : '';
    const pubDateElement = pubDateString ? `<pubDate>${pubDateString}</pubDate>` : '';


    const titleCDATA = `<![CDATA[${itemData.title || ''}]]>`;
    const descriptionCDATA = `<![CDATA[${String(itemData.descriptionContent || '')}]]>`;
    const linkElement = itemData.link ? `<link>${escapeXmlMinimal(itemData.link)}</link>` : '';
    
    let guidElement;
    if (itemData.id) { // Prefer existing ID if normalized
        guidElement = `<guid isPermaLink="${itemData.link === itemData.id && !!itemData.link}">${escapeXmlMinimal(itemData.id)}</guid>`;
    } else if (itemData.link) {
        guidElement = `<guid isPermaLink="true">${escapeXmlMinimal(itemData.link)}</guid>`;
    } else {
        const stringToHash = `${itemData.title || ''}::${itemData.descriptionContent || ''}`;
        const fallbackGuid = crypto.createHash('sha1').update(stringToHash).digest('hex');
        guidElement = `<guid isPermaLink="false">${fallbackGuid}</guid>`;
    }
    const customFieldsXml = generateCustomFieldsXml(itemData.customFields); 

    return `<item>
                <title>${titleCDATA}</title>
                <description>${descriptionCDATA}</description>
                ${linkElement}
                ${guidElement}
                ${pubDateElement}
                ${customFieldsXml ? customFieldsXml : ''}
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
    const itemXmlStrings = items.map(item => generateRssItemXml(item)).join('\n            ');

    let descriptionText = metadata.description || '';
    if (metadata.itemCountLimited || metadata.itemCharLimited) {
        descriptionText += ' [Feed truncated by limit]';
    }

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>    
                    <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
                    <channel>
                        <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>
                        <link>${escapeXmlMinimal(metadata.link || '')}</link>
                        ${metadata.feedUrl ? `<atom:link href="${escapeXmlMinimal(metadata.feedUrl)}" rel="self" type="application/rss+xml" />` : ''}
                        <description>${escapeXmlMinimal(descriptionText || '')}</description>
                        <lastBuildDate>${lastBuildDateString}</lastBuildDate>
                        ${metadata.language ? `<language>${escapeXmlMinimal(metadata.language)}</language>` : ''}
                        ${metadata.generator ? `<generator>${escapeXmlMinimal(metadata.generator)}</generator>` : ''}
                        ${itemXmlStrings}
                    </channel>
                    </rss>`;

    return feedXml.replace(/\n\s+\n/g, '\n'); // Clean up potential extra newlines from empty elements
}

function generateAtomEntryXml(itemData, feedMetadata) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject : null; 
    const updatedString = itemDate ? formatISO(itemDate) : formatISO(new Date()); // Fallback to now if no item date

    const title = itemData.title || 'Untitled Entry';
    const description = String(itemData.descriptionContent || '');
    const link = itemData.link;

    let entryId;
    if (itemData.id) { // Prefer existing ID
        entryId = itemData.id;
    } else if (link && link.startsWith('http')) {
        entryId = link;
    } else {
        const baseId = feedMetadata.id || feedMetadata.link || `urn:uuid:${crypto.createHash('sha1').update(feedMetadata.title || 'feed').digest('hex')}`;
        const stringToHash = `${title}::${description}::${updatedString}`;
        const hash = crypto.createHash('sha1').update(stringToHash).digest('hex');
        entryId = `${baseId}:${hash}`;
    }

    const titleElement = `<title type="html"><![CDATA[${title}]]></title>`; // Use CDATA for title
    const idElement = `<id>${escapeXmlMinimal(entryId)}</id>`;
    const updatedElement = `<updated>${updatedString}</updated>`;
    const linkElement = link ? `<link href="${escapeXmlMinimal(link)}" rel="alternate" />` : '';
    const contentElement = `<content type="html"><![CDATA[${description}]]></content>`;
    const customFieldsXml = generateCustomFieldsXml(itemData.customFields);

    return `<entry>
                ${titleElement}
                ${idElement}
                ${updatedElement}
                ${linkElement}
                ${contentElement}
                ${customFieldsXml ? customFieldsXml : ''}
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
   const entryXmlStrings = items.map(item => generateAtomEntryXml(item, metadata)).join('\n            ');

   let subtitleText = metadata.description || '';
   if (metadata.itemCountLimited || metadata.itemCharLimited) {
       subtitleText += ' [Feed truncated by limit]';
   }
   const subtitleElement = subtitleText ? `<subtitle type="html"><![CDATA[${subtitleText}]]></subtitle>` : '';

   const feedXml = `<?xml version="1.0" encoding="utf-8"?>
                    <feed xmlns="http://www.w3.org/2005/Atom" ${metadata.language ? `xml:lang="${escapeXmlMinimal(metadata.language)}"` : ''}>
                    <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>
                    ${subtitleElement}
                    <link href="${escapeXmlMinimal(metadata.feedUrl || '')}" rel="self" type="application/atom+xml"/>
                    <link href="${escapeXmlMinimal(metadata.link || '')}" rel="alternate"/>
                    <id>${escapeXmlMinimal(feedId)}</id>
                    <updated>${feedUpdatedString}</updated>
                    ${metadata.generator ? `<generator uri="https://github.com/tgel0/crssnt" version="1.0">${escapeXmlMinimal(metadata.generator)}</generator>` : ''}
                    ${entryXmlStrings}
                    </feed>`;

   return feedXml.replace(/\n\s+\n/g, '\n');
}


function generateJsonFeedObject(feedData, groupByFeedInternal = false, multipleSources = false, isLlmCompact = false) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
        console.error("Invalid feedData passed to generateJsonFeedObject");
        return {
            version: "https://jsonfeed.org/version/1.1",
            title: "Error Generating Feed",
            description: "Could not generate feed due to invalid data.",
            items: []
        };
    }
    const { metadata, items } = feedData;

    let descriptionText = metadata.description || '';
    if (!isLlmCompact && (metadata.itemCountLimited || metadata.itemCharLimited)) { 
        descriptionText += ' Note: This feed may be incomplete due to configured limits.';
    }

    const mapItemToJson = (item) => {
        const itemDate = (item.dateObject instanceof Date && isValid(item.dateObject)) ? item.dateObject : null;
        let itemId;
        if (item.id) itemId = item.id;
        else if (item.link && item.link.startsWith('http')) itemId = item.link;
        else {
            const stringToHash = `${item.title || ''}::${String(item.descriptionContent || '')}::${itemDate ? formatISO(itemDate) : 'no-date'}`;
            itemId = `${metadata.id || 'urn:uuid:temp'}:${crypto.createHash('sha1').update(stringToHash).digest('hex')}`;
        }
        
        const jsonItem = {
            id: isLlmCompact ? undefined : itemId, // Omitting ID for LLM mode for max brevity
            url: item.link, 
            title: item.title,
            content_text: String(item.descriptionContent || ''), 
            date_published: itemDate ? formatISO(itemDate) : undefined, 
        };
        
        if (item.customFields && !isLlmCompact) { 
            jsonItem._crssnt_custom_fields = item.customFields;
        }
        
        if (metadata.groupByFeed && item.sourceInfo) { 
            jsonItem._source_feed = {
                title: item.sourceInfo.title,
            };
            if (!isLlmCompact && item.sourceInfo.url) { 
                 jsonItem._source_feed.url = item.sourceInfo.url;
            }
        }
        Object.keys(jsonItem).forEach(key => jsonItem[key] === undefined && delete jsonItem[key]);
        return jsonItem;
    };

    const jsonFeed = {
        version: "https://jsonfeed.org/version/1.1",
        title: isLlmCompact ? undefined : (metadata.title || 'Untitled Feed'), 
        home_page_url: isLlmCompact ? undefined : metadata.link, 
        feed_url: isLlmCompact ? undefined : metadata.feedUrl,   
        description: isLlmCompact ? undefined : descriptionText, 
        items: items.map(mapItemToJson)
    };

    if (!isLlmCompact) {
        if (metadata.language) jsonFeed.language = metadata.language;
        if (metadata.generator) jsonFeed._crssnt_generator = metadata.generator;
    }
    
    Object.keys(jsonFeed).forEach(key => jsonFeed[key] === undefined && delete jsonFeed[key]);
    return jsonFeed;
}


function generateMarkdown(feedData, groupByFeedInternal = false, multipleSources = false, isLlmCompact = false) { 
   if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
       return isLlmCompact ? "Error: Invalid data." : "# Error Generating Feed\n\nCould not generate feed due to invalid data.";
   }
   const { metadata, items } = feedData;
   let md = '';

   if (isLlmCompact) {
       const outputLines = [];
       if (metadata.groupByFeed) {
           const groupedItems = {};
           items.forEach(item => {
               const sourceKey = item.sourceInfo ? item.sourceInfo.url : 'unknown_source';
               if (!groupedItems[sourceKey]) {
                   groupedItems[sourceKey] = {
                       title: item.sourceInfo ? item.sourceInfo.title : 'Unknown Source',
                       items: []
                   };
               }
               groupedItems[sourceKey].items.push(item);
           });

           let firstGroup = true;
           for (const sourceKey in groupedItems) {
               if (!firstGroup) {
                   outputLines.push("---"); // Separator between source groups
               }
               const group = groupedItems[sourceKey];
               outputLines.push(`# ${group.title}`); // H1 for Source Title
               group.items.forEach(item => {
                   outputLines.push(`## ${item.title || '(Untitled)'}`); // H2 for Item Title
                   outputLines.push(String(item.descriptionContent || '').replace(/\n+/g, ' ')); // Replace newlines in desc with space
                   if (item.link) outputLines.push(`Link: ${item.link}`);
                   if (item.dateObject && isValid(item.dateObject)) outputLines.push(`Date: ${formatISO(item.dateObject)}`);
               });
               firstGroup = false;
           }
       } else { // Not grouped
           items.forEach((item, index) => {
               if (index > 0) {
                   outputLines.push("---"); // Separator between items
               }
               outputLines.push(`# ${item.title || '(Untitled)'}`); // H1 for Item Title
               outputLines.push(String(item.descriptionContent || '').replace(/\n+/g, ' ')); // Replace newlines in desc with space
               if (item.link) outputLines.push(`Link: ${item.link}`);
               if (item.dateObject && isValid(item.dateObject)) outputLines.push(`Date: ${formatISO(item.dateObject)}`);
           });
       }

       const itemStrings = [];
       if (metadata.groupByFeed) {
            const groupedItems = {};
            items.forEach(item => {
                const sourceKey = item.sourceInfo ? item.sourceInfo.url : 'unknown_source';
                if (!groupedItems[sourceKey]) {
                    groupedItems[sourceKey] = { title: item.sourceInfo ? item.sourceInfo.title : 'Unknown Source', items: [] };
                }
                groupedItems[sourceKey].items.push(item);
            });
            for (const sourceKey in groupedItems) {
                const group = groupedItems[sourceKey];
                let groupString = `# ${group.title}`;
                const groupItemStrings = [];
                group.items.forEach(item => {
                    let itemStr = `## ${item.title || '(Untitled)'} ${String(item.descriptionContent || '').replace(/\n+/g, ' ')}`;
                    if (item.link) itemStr += ` Link: ${item.link}`;
                    if (item.dateObject && isValid(item.dateObject)) itemStr += ` Date: ${formatISO(item.dateObject)}`;
                    groupItemStrings.push(itemStr);
                });
                groupString += " " + groupItemStrings.join(" --- "); // Item separator within group
                itemStrings.push(groupString);
            }
       } else {
            items.forEach(item => {
                let itemStr = `# ${item.title || '(Untitled)'} ${String(item.descriptionContent || '').replace(/\n+/g, ' ')}`;
                if (item.link) itemStr += ` Link: ${item.link}`;
                if (item.dateObject && isValid(item.dateObject)) itemStr += ` Date: ${formatISO(item.dateObject)}`;
                itemStrings.push(itemStr);
            });
       }
       md = itemStrings.join(" ||| "); // Separator between groups or items if not grouped

       if (metadata.itemCountLimited || metadata.itemCharLimited) {
           md += " [TRUNCATED]";
       }
       return md.trim();
   }

   // Regular Markdown output (remains multi-line and structured)
   md += `# ${escapeMarkdown(metadata.title || 'Untitled Feed')}\n\n`;
   if (metadata.link) md += `**Source (Combined View):** [${escapeMarkdown(metadata.link)}](${escapeMarkdown(metadata.link)})\n`;
   if (metadata.feedUrl) md += `**Feed URL (This Feed):** [${escapeMarkdown(metadata.feedUrl)}](${escapeMarkdown(metadata.feedUrl)})\n`;
   if (metadata.description) md += `\n*${escapeMarkdown(metadata.description)}*\n`;
   if (metadata.itemCountLimited || metadata.itemCharLimited) {
       md += `\n**Note: This feed may be incomplete due to configured limits.**\n`;
   }
   md += `\n---\n\n`;

   if (items.length === 0) {
       md += "_No items found._\n";
   } else {
       if (metadata.groupByFeed) { 
           const groupedItems = {};
           items.forEach(item => {
               const sourceKey = item.sourceInfo ? item.sourceInfo.url : 'unknown_source';
               if (!groupedItems[sourceKey]) {
                   groupedItems[sourceKey] = {
                       title: item.sourceInfo ? item.sourceInfo.title : 'Unknown Source',
                       url: item.sourceInfo ? item.sourceInfo.url : '#',
                       items: []
                   };
               }
               groupedItems[sourceKey].items.push(item);
           });
           for (const sourceKey in groupedItems) {
               const group = groupedItems[sourceKey];
               md += `## From: ${escapeMarkdown(group.title)} ([${escapeMarkdown(group.url)}](${escapeMarkdown(group.url)}))\n\n`;
               group.items.forEach(item => md += renderMarkdownItem(item, false)); // Standard rendering for items in group
           }
       } else {
           items.forEach(item => md += renderMarkdownItem(item, false)); // Standard rendering
       }
   }
   return md;
}

// This function is now primarily for the non-compact Markdown path.
function renderMarkdownItem(item, isLlmCompact = false) {
    if (isLlmCompact) { 
        let itemStr = `${item.title || '(Untitled)'} - ${String(item.descriptionContent || '').replace(/\n+/g, ' ')}`;
        if (item.link) itemStr += ` (${item.link})`;
        if (item.dateObject && isValid(item.dateObject)) itemStr += ` [${formatISO(item.dateObject)}]`;
        return itemStr;
    }

    // Regular Markdown item rendering
    let itemMd = `### ${escapeMarkdown(item.title || '(Untitled)')}\n\n`;
    if (item.dateObject instanceof Date && isValid(item.dateObject)) {
        itemMd += `*Published: ${format(item.dateObject, 'PPPppp', { timeZone: 'GMT' })} (GMT)*\n`;
    }
    if (item.link) {
        itemMd += `**Link:** [${escapeMarkdown(item.link)}](${escapeMarkdown(item.link)})\n`;
    }
    itemMd += `\n${String(item.descriptionContent || '')}\n\n`; 
    if (item.customFields) {
        itemMd += `**Custom Fields:**\n`;
        for (const key in item.customFields) {
            itemMd += `* ${escapeMarkdown(key)}: ${escapeMarkdown(String(item.customFields[key]))}\n`;
        }
        itemMd += `\n`;
    }
    itemMd += `\n---\n\n`;
    return itemMd;
}


function generateBlockedFeedPlaceholder(sheetID, outputFormat, feedBaseUrl) {
    const statusCode = 410; // Gone
    let placeholderFeed = '';
    let contentType = '';
    const placeholderTitle = "Feed Unavailable";
    const placeholderDesc = `The requested Google Sheet (ID: ${sheetID}) is currently unavailable or has been blocked by the administrator.`;
    const placeholderLink = 'https://crssnt.com/'; // General link to the service

    if (outputFormat === 'atom') {
        contentType = 'application/atom+xml; charset=utf8';
        const updated = formatISO(new Date());
        const feedId = `urn:crssnt:blocked:${sheetID}`;
        placeholderFeed = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${escapeXmlMinimal(placeholderTitle)}</title><link href="${escapeXmlMinimal(placeholderLink)}" rel="alternate"/><id>${escapeXmlMinimal(feedId)}</id><updated>${updated}</updated><subtitle>${escapeXmlMinimal(placeholderDesc)}</subtitle><entry><title>Sheet Unavailable</title><id>${escapeXmlMinimal(feedId)}:entry:${Date.now()}</id><updated>${updated}</updated><content type="text">${escapeXmlMinimal(placeholderDesc)}</content></entry></feed>`;
    } else { // Default to RSS
        contentType = 'application/rss+xml; charset=utf8';
        const pubDate = format(new Date(), "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
        placeholderFeed = `<?xml version="1.0" encoding="UTF-8"?>
                            <rss version="2.0">
                            <channel>
                            <title>${escapeXmlMinimal(placeholderTitle)}</title>
                            <link>${escapeXmlMinimal(placeholderLink)}</link>
                            <description>${escapeXmlMinimal(placeholderDesc)}</description>
                            <lastBuildDate>${pubDate}</lastBuildDate>
                            <item>
                                <title>Sheet Unavailable</title>
                                <description>${escapeXmlMinimal(placeholderDesc)}</description>
                                <pubDate>${pubDate}</pubDate>
                                <guid isPermaLink="false">unavailable-${escapeXmlMinimal(sheetID)}-${Date.now()}</guid>
                            </item>
                            </channel>
                            </rss>`;
    }
    return { feedXml: placeholderFeed, contentType, statusCode };
}


module.exports = {
    getSheetData,
    buildFeedData,
    fetchUrlContent,
    parseXmlFeedWithCheerio,
    normalizeParsedFeed,
    processMultipleUrls,
    generateRssFeed,
    generateAtomFeed,
    generateJsonFeedObject,
    generateMarkdown,    
    generateBlockedFeedPlaceholder,
    escapeMarkdown, 
    escapeXmlMinimal
};
