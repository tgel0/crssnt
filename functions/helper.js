const crypto = require('crypto');
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const { parseISO, isValid, format, formatISO } = require('date-fns');
const cheerio = require('cheerio'); 


// --- XML/Markdown Escaping ---
function escapeXmlMinimal(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/[<>&"']/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '"': return '&quot;';
        case "'": return '&apos;';
        default: return c;
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
    if (!dateString || typeof dateString !== 'string') return null;
    let parsedDate = null;
    try {
        // Attempt to parse as ISO 8601 first
        parsedDate = parseISO(dateString);
        if (isValid(parsedDate)) return parsedDate;
    } catch (e) { /* ignore */ }
    try {
        // Fallback to generic Date constructor
        parsedDate = new Date(dateString);
        if (isValid(parsedDate)) return parsedDate;
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
        // Sort by date descending (newest first)
        if (dateA && dateB) return dateB.getTime() - dateA.getTime();
        // Items with dates come before items without dates
        if (dateA) return -1;
        if (dateB) return 1;
        // If neither has a date, maintain original relative order (or sort by title as a secondary criterion if needed)
        return 0;
    });
}

// --- Google Sheet Fetching ---
async function getSheetData(sheetID, sheetNames, apiKey) {
    const metaRequest = { spreadsheetId: sheetID, key: apiKey };
    const spreadsheetMeta = (await sheets.spreadsheets.get(metaRequest)).data;
    const sheetTitle = spreadsheetMeta.properties.title;
    let targetSheetNames = [];

    // Determine which sheet names to target
    if (sheetNames === undefined || (Array.isArray(sheetNames) && sheetNames.length === 0)) {
        // If no specific names, find the first visible sheet or default to 'Sheet1'
        const firstVisibleSheet = spreadsheetMeta.sheets.find(s => !s.properties.hidden);
        targetSheetNames = firstVisibleSheet ? [firstVisibleSheet.properties.title] : ['Sheet1'];
    } else if (typeof sheetNames === 'string') {
        targetSheetNames = [sheetNames];
    } else { // sheetNames is an array
        targetSheetNames = sheetNames;
    }

    const ranges = targetSheetNames.map(name => name); // Sheet names are valid ranges
    const valuesRequest = { spreadsheetId: sheetID, key: apiKey, ranges: ranges, majorDimension: 'ROWS' };
    const batchGetResponse = (await sheets.spreadsheets.values.batchGet(valuesRequest)).data;
    
    const sheetData = {}; // Store data keyed by sheet name
    if (batchGetResponse.valueRanges) {
        batchGetResponse.valueRanges.forEach(valueRange => {
            // Extract sheet name from the range string (e.g., "Sheet1!A1:Z1000" -> "Sheet1")
            const rangeName = valueRange.range.split('!')[0].replace(/'/g, ''); // Remove single quotes if present
            sheetData[rangeName] = valueRange.values || []; // Ensure empty array if no values
        });
    }
    return { title: sheetTitle, sheetData: sheetData };
}

// --- Sheet Data Parsing ---
function parseSheetRowAutoMode(row) {
    if (!row || row.length === 0) return null;
    let title = '', titleIndex = -1;
    // Find the first non-empty cell as title
    for (let i = 0; i < row.length; i++) {
        const cellValue = String(row[i] || '').trim();
        if (cellValue !== '') { title = cellValue; titleIndex = i; break; }
    }
    if (titleIndex === -1) return null; // Skip row if no title found

    const remainingRowData = row.filter((_, index) => index !== titleIndex);
    let link, dateObject = null, descriptionContent = '';
    const potentialDescriptionCells = [];

    for (const cell of remainingRowData) {
        const cellString = String(cell || '');
        // Check for link
        if (!link && cellString.startsWith('http')) {
            try { new URL(cellString); link = cellString; continue; } catch (e) { /* not a valid URL */ }
        }
        // Check for date
        if (!dateObject) {
            const parsed = parseDateString(cellString);
            if (parsed instanceof Date && isValid(parsed)) { dateObject = parsed; continue; }
        }
        potentialDescriptionCells.push(cellString);
    }
    descriptionContent = potentialDescriptionCells.filter(s => String(s || '').trim() !== '').join(' ');
    return { title, link, dateObject, descriptionContent };
}

function generateItemData(values, mode) {
    let items = [];
    if (mode.toLowerCase() === 'manual') {
        items = generateFeedManualModeInternal(values);
    } else { // Auto mode
        items = values.map(row => parseSheetRowAutoMode(row)).filter(item => item !== null);
    }
    // Sorting of items from a single sheet/source is done here before limiting
    sortFeedItems(items);
    return items; 
}

function generateFeedManualModeInternal(values) {
    const items = [];
    if (!values || values.length < 2) return items; // Need header + at least one data row
    const headers = values[0];
    const headerMap = {}; // Stores index for standard fields
    const customHeaderMap = {}; // Stores index for custom fields, using original header name as key

    // Define aliases for standard feed fields
    const standardFieldAliases = {
        title: ['title'],
        link: ['link', 'url', 'uri', 'href'],
        description: ['description', 'desc', 'summary', 'content', 'content:encoded'], // Treat content:encoded as description
        dateObject: ['pubdate', 'date', 'published', 'updated', 'timestamp', 'created']
    };

    // Map headers to standard fields or custom fields
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

    const titleIndex = headerMap['title'];
    const linkIndex = headerMap['link'];
    const descriptionIndex = headerMap['description'];
    const dateIndex = headerMap['dateObject'];

    // Process data rows
    for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (!row || row.every(cell => String(cell || '').trim() === '')) continue; // Skip empty/whitespace-only rows

        let title = titleIndex !== undefined ? String(row[titleIndex] || '').trim() : '';
        if (title === '') title = '(Untitled)'; // Placeholder if title column exists but cell is empty

        const link = linkIndex !== undefined ? String(row[linkIndex] || '').trim() : undefined;
        const descriptionContent = descriptionIndex !== undefined ? String(row[descriptionIndex] || '') : '';
        const dateString = dateIndex !== undefined ? String(row[dateIndex] || '') : undefined;
        let dateObject = parseDateString(dateString); // Can be null

        // Collect custom fields
        const customFields = {};
        for (const originalCustomHeader in customHeaderMap) {
            const customIndex = customHeaderMap[originalCustomHeader];
            const customValue = row[customIndex] || '';
            if (String(customValue).trim() !== '') {
                // Sanitize header to create a valid XML tag name for later use
                const tagName = originalCustomHeader.replace(/[^a-zA-Z0-9_:-]/g, '_').replace(/^[^a-zA-Z_:]/, '_');
                if (tagName) { // Ensure tagName is not empty after sanitization
                    customFields[tagName] = String(customValue);
                }
            }
        }

        items.push({
             title,
             link: link || undefined, // Ensure undefined if empty
             dateObject, // Can be null
             descriptionContent,
             customFields: Object.keys(customFields).length > 0 ? customFields : undefined // Add only if non-empty
        });
    }
    return items;
}

function buildFeedData(sheetData, mode, sheetTitle, sheetID, requestUrl, itemLimit = 50, charLimit = 500, isPreview = false) {
    let allItems = [];
    let anySheetWasItemLimited = false;
    let anySheetWasCharLimited = false;

    // Iterate over each sheet's data provided in sheetData object
    Object.keys(sheetData).forEach(sheetName => {
        let itemsFromSheet = generateItemData(sheetData[sheetName], mode); // generateItemData now sorts items from this sheet

        // Apply itemLimit per sheet
        if (itemsFromSheet.length > itemLimit) {
            itemsFromSheet = itemsFromSheet.slice(0, itemLimit);
            anySheetWasItemLimited = true;
        }

        // Apply charLimit per sheet
        itemsFromSheet = itemsFromSheet.map(item => {
            const desc = String(item.descriptionContent || '');
            if (desc.length > charLimit) {
                item.descriptionContent = desc.slice(0, charLimit) + '...';
                anySheetWasCharLimited = true;
            }
            return item;
        });
        
        allItems = allItems.concat(itemsFromSheet);
    });

    // Sort the globally combined list of (already per-sheet-limited) items
    sortFeedItems(allItems); 

    // Determine the latest date for the feed's lastBuildDate from the final combined & sorted list
    const latestItemDate = allItems.length > 0 && allItems[0].dateObject instanceof Date && isValid(allItems[0].dateObject)
        ? allItems[0].dateObject
        : new Date(); 
    
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
            itemCountLimited: anySheetWasItemLimited, 
            isPreview: isPreview, // True if any sheet hit its item limit
            itemCharLimited: anySheetWasCharLimited  // True if any item in any sheet hit char limit
        },
        items: allItems // This is the final list of items, potentially combined from multiple sheets
    };
}

// --- External Feed Fetching & Parsing ---
async function fetchUrlContent(url) {
    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'crssnt-feed-generator/1.0 (+https://crssnt.com)' }});
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }
        return await response.text();
    } catch (error) {
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
    let feedTitle = '', feedLink = '', feedDescription = '', feedLastBuildDate = null,
        feedLanguage = 'en', feedGenerator = 'crssnt (converted)', feedId = sourceUrl;
    
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
            const rawDescription = $item.find('> description').html() || $item.find('content\\:encoded').html() || ''; 
            const descriptionContent = _stripCdataWrapper(rawDescription);
            const pubDateStr = $item.find('> pubDate').text().trim();
            const dateObject = parseDateString(pubDateStr);
            const guid = $item.find('> guid').text().trim() || link; 
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
        feedLanguage = feed.attr('xml:lang') || feed.find('> language').text().trim() || 'en'; 
        const generatorNode = feed.find('generator').first();
        feedGenerator = generatorNode.text().trim() || feedGenerator;
        if (generatorNode.attr('uri')) feedGenerator += ` (${generatorNode.attr('uri')})`;

        feed.find('entry').each((i, el) => {
            const $entry = $(el);
            const title = $entry.find('> title').text().trim() || '(Untitled)';
            const link = $entry.find('> link[rel="alternate"]').attr('href') || $entry.find('> link').first().attr('href');
            const rawDescription = $entry.find('> content').html() || $entry.find('> summary').html() || ''; 
            const descriptionContent = _stripCdataWrapper(rawDescription);
            const updatedStrEntry = $entry.find('> updated').text().trim() || $entry.find('> published').text().trim(); 
            const dateObject = parseDateString(updatedStrEntry);
            const id = $entry.find('> id').text().trim() || link;
            items.push({ title, link, dateObject, descriptionContent, id, sourceInfo: { title: feedTitle, url: sourceUrl, type: 'atom' } });
        });
    } else {
        feedTitle = "Unknown or Invalid Feed Type";
        feedDescription = `Could not determine feed type (RSS or Atom) for URL: ${sourceUrl}. Please ensure it's a valid XML feed.`;
    }

    sortFeedItems(items); 

    let itemCountLimited = false;
    let itemCharLimited = false;
    let limitedItems = items;

    // Apply itemLimit to this individual feed's items
    if (itemLimit !== Infinity && items.length > itemLimit) {
        limitedItems = items.slice(0, itemLimit);
        itemCountLimited = true;
    }
    // Apply charLimit to this individual feed's items
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
    
    if (!feedLastBuildDate && limitedItems.length > 0 && limitedItems[0].dateObject) {
        feedLastBuildDate = limitedItems[0].dateObject;
    }

    return {
        metadata: {
            title: feedTitle || 'Untitled Parsed Feed',
            link: feedLink || sourceUrl, 
            feedUrl: sourceUrl,        
            description: feedDescription,
            lastBuildDate: feedLastBuildDate, 
            language: feedLanguage,
            generator: feedGenerator,
            id: feedId, 
            itemCountLimited: itemCountLimited, 
            itemCharLimited: itemCharLimited,   
            sourceType 
        },
        items: limitedItems 
    };
}

async function processMultipleUrls(sourceUrls, requestUrl, itemLimit = 50, charLimit = 500, groupByFeed = false) {
    let allItems = [];
    const allFeedMetadata = []; 
    let anyIndividualFeedWasItemLimited = false; 
    let anyIndividualFeedWasCharLimited = false; 

    for (const sourceUrl of sourceUrls) {
        try {
            const xmlString = await fetchUrlContent(sourceUrl);
            const $ = parseXmlFeedWithCheerio(xmlString);
            
            const individualFeedData = normalizeParsedFeed($, sourceUrl, itemLimit, charLimit); 

            if (individualFeedData && individualFeedData.items && individualFeedData.metadata.sourceType !== 'unknown') {
                allItems = allItems.concat(individualFeedData.items);
                allFeedMetadata.push(individualFeedData.metadata);
                if (individualFeedData.metadata.itemCountLimited) {
                    anyIndividualFeedWasItemLimited = true;
                }
                if (individualFeedData.metadata.itemCharLimited) {
                    anyIndividualFeedWasCharLimited = true;
                }
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

    if (!groupByFeed) {
        sortFeedItems(allItems); 
    }
    
    const finalLimitedItems = allItems; 
    
    const firstValidMetadata = allFeedMetadata.length > 0 ? allFeedMetadata[0] : {};
    const combinedTitle = allFeedMetadata.length > 1 
        ? `Combined Feed from ${allFeedMetadata.length} sources (up to ${itemLimit} items per source)` 
        : (firstValidMetadata.title || `Feed from ${firstValidMetadata.feedUrl || 'source'}`); 
    
    const combinedLink = requestUrl; 
    const combinedId = `urn:crssnt:combined:${crypto.createHash('sha1').update(sourceUrls.join(',')).digest('hex')}`;
    
    let overallLastBuildDate;
    if (!groupByFeed && finalLimitedItems.length > 0 && finalLimitedItems[0].dateObject instanceof Date && isValid(finalLimitedItems[0].dateObject)) {
        overallLastBuildDate = finalLimitedItems[0].dateObject;
    } else if (groupByFeed && allFeedMetadata.length > 0) {
        overallLastBuildDate = allFeedMetadata.reduce((latest, meta) => {
            if (meta.lastBuildDate && (!latest || meta.lastBuildDate.getTime() > latest.getTime())) {
                return meta.lastBuildDate;
            }
            return latest;
        }, null);
        if (!overallLastBuildDate && finalLimitedItems.length > 0) {
            let latestItemDateInGrouped = null;
            for (const item of finalLimitedItems) {
                if (item.dateObject && isValid(item.dateObject)) {
                    if (!latestItemDateInGrouped || item.dateObject.getTime() > latestItemDateInGrouped.getTime()) {
                        latestItemDateInGrouped = item.dateObject;
                    }
                }
            }
            overallLastBuildDate = latestItemDateInGrouped;
        }
    }
    overallLastBuildDate = overallLastBuildDate || new Date(); 

    let combinedFeedDescription = allFeedMetadata.length > 1
        ? `A combined feed generated from ${allFeedMetadata.length} sources (up to ${itemLimit} items per source) via crssnt.`
        : (firstValidMetadata.description || `Feed generated from ${firstValidMetadata.feedUrl || 'source'} (up to ${itemLimit} items) via crssnt.`);
    // The generic truncation notice will be added by the output functions if needed.

    return {
        metadata: {
            title: combinedTitle,
            link: combinedLink, 
            feedUrl: requestUrl, 
            description: combinedFeedDescription, 
            lastBuildDate: overallLastBuildDate,
            generator: 'https://github.com/tgel0/crssnt (combined)',
            id: combinedId,
            itemCountLimited: anyIndividualFeedWasItemLimited, 
            itemCharLimited: anyIndividualFeedWasCharLimited, 
            language: firstValidMetadata.language || 'en',
            groupByFeed: groupByFeed && sourceUrls.length > 1 
        },
        items: finalLimitedItems 
    };
}


// --- Feed Output Generation ---
function generateCustomFieldsXml(customFields) {
    if (!customFields || typeof customFields !== 'object') return '';
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
                     : null; 

    const pubDateString = itemDate ? format(itemDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' }) : '';
    const pubDateElement = pubDateString ? `<pubDate>${pubDateString}</pubDate>` : '';


    const titleCDATA = `<![CDATA[${itemData.title || ''}]]>`;
    const descriptionCDATA = `<![CDATA[${String(itemData.descriptionContent || '')}]]>`; 
    const linkElement = itemData.link ? `<link>${escapeXmlMinimal(itemData.link)}</link>` : '';
    
    let guidElement;
    if (itemData.id) { 
        guidElement = `<guid isPermaLink="${itemData.link === itemData.id && !!itemData.link}">${escapeXmlMinimal(itemData.id)}</guid>`;
    } else if (itemData.link) {
        guidElement = `<guid isPermaLink="true">${escapeXmlMinimal(itemData.link)}</guid>`;
    } else {
        const stringToHash = `${itemData.title || ''}::${itemData.descriptionContent || ''}`;
        const fallbackGuid = crypto.createHash('sha1').update(stringToHash).digest('hex');
        guidElement = `<guid isPermaLink="false">${fallbackGuid}</guid>`;
    }
    const customFieldsXml = generateCustomFieldsXml(itemData.customFields); 

    return `<item>\n                <title>${titleCDATA}</title>\n                <description>${descriptionCDATA}</description>\n                ${linkElement}\n                ${guidElement}\n                ${pubDateElement}\n                ${customFieldsXml ? customFieldsXml + '\n            ' : ''}</item>`;
}


function generateRssFeed(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
        console.error("Invalid feedData passed to generateRssFeed");
        return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Error Generating Feed</title><link>${escapeXmlMinimal(feedData?.metadata?.link || '')}</link><description>Could not generate feed due to invalid data.</description></channel></rss>`;
    }

    const { metadata, items } = feedData;

    const lastBuildDate = (metadata.lastBuildDate instanceof Date && isValid(metadata.lastBuildDate))
                          ? metadata.lastBuildDate
                          : new Date();
    const lastBuildDateString = format(lastBuildDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
    const itemXmlStrings = items.map(item => generateRssItemXml(item)).join('\n            ');

    let descriptionText = metadata.description || '';
    if (metadata.isPreview) {
        const deprecationNotice = "DEPRECATION NOTICE: This /preview endpoint is deprecated and will be removed in a future update. Please migrate to the v1/sheet/rss and v1/sheet/atom endpoints for continued service. ";
        descriptionText = deprecationNotice + descriptionText;
    }
    if (metadata.itemCountLimited || metadata.itemCharLimited) {
        descriptionText += ' [Note: Feed content may be truncated due to limits.]';
    }


    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n<channel>\n    <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>\n    <link>${escapeXmlMinimal(metadata.link || '')}</link>\n    ${metadata.feedUrl ? `<atom:link href="${escapeXmlMinimal(metadata.feedUrl)}" rel="self" type="application/rss+xml" />\n    ` : ''}<description>${escapeXmlMinimal(descriptionText || '')}</description>\n    <lastBuildDate>${lastBuildDateString}</lastBuildDate>\n    ${metadata.language ? `<language>${escapeXmlMinimal(metadata.language)}</language>\n    ` : ''}${metadata.generator ? `<generator>${escapeXmlMinimal(metadata.generator)}</generator>\n    ` : ''}${itemXmlStrings}\n</channel>\n</rss>`;
}

function generateAtomEntryXml(itemData, feedMetadata) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject : null; 
    const updatedString = itemDate ? formatISO(itemDate) : formatISO(new Date()); 

    const title = itemData.title || 'Untitled Entry';
    const description = String(itemData.descriptionContent || ''); 
    const link = itemData.link;

    let entryId;
    if (itemData.id) { 
        entryId = itemData.id;
    } else if (link && link.startsWith('http')) { 
        entryId = link;
    } else {
        const baseId = feedMetadata.id || feedMetadata.link || `urn:uuid:${crypto.createHash('sha1').update(feedMetadata.title || 'feed').digest('hex')}`;
        const stringToHash = `${title}::${description}::${updatedString}`;
        const hash = crypto.createHash('sha1').update(stringToHash).digest('hex');
        entryId = `${baseId}:${hash}`;
    }

    const titleElement = `<title type="html"><![CDATA[${title}]]></title>`; 
    const idElement = `<id>${escapeXmlMinimal(entryId)}</id>`;
    const updatedElement = `<updated>${updatedString}</updated>`;
    const linkElement = link ? `<link href="${escapeXmlMinimal(link)}" rel="alternate" />` : '';
    const contentElement = `<content type="html"><![CDATA[${description}]]></content>`;
    const customFieldsXml = generateCustomFieldsXml(itemData.customFields);

    return `<entry>\n                ${titleElement}\n                ${idElement}\n                ${updatedElement}\n                ${linkElement}\n                ${contentElement}\n                ${customFieldsXml ? customFieldsXml + '\n            ' : ''}</entry>`;
}

function generateAtomFeed(feedData) {
   if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
       console.error("Invalid feedData passed to generateAtomFeed");
       return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Error Generating Feed</title><id>urn:uuid:error</id><updated>${formatISO(new Date())}</updated></feed>`;
   }
   const { metadata, items } = feedData;

   const feedUpdatedDate = (metadata.lastBuildDate instanceof Date && isValid(metadata.lastBuildDate))
                         ? metadata.lastBuildDate : new Date();
   const feedUpdatedString = formatISO(feedUpdatedDate);

   const feedId = metadata.id || metadata.feedUrl || metadata.link || `urn:uuid:${crypto.createHash('sha1').update(metadata.title || 'untitled').digest('hex')}`;
   const entryXmlStrings = items.map(item => generateAtomEntryXml(item, metadata)).join('\n            ');

   let subtitleText = metadata.description || '';
    if (metadata.itemCountLimited || metadata.itemCharLimited) {
        subtitleText += ' [Note: Feed content may be truncated due to limits.]';
    }
   const subtitleElement = subtitleText ? `<subtitle type="html"><![CDATA[${subtitleText}]]></subtitle>` : '';

   return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" ${metadata.language ? `xml:lang="${escapeXmlMinimal(metadata.language)}"` : ''}>\n<title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>\n${subtitleElement}\n<link href="${escapeXmlMinimal(metadata.feedUrl || '')}" rel="self" type="application/atom+xml"/>\n<link href="${escapeXmlMinimal(metadata.link || '')}" rel="alternate"/>\n<id>${escapeXmlMinimal(feedId)}</id>\n<updated>${feedUpdatedString}</updated>\n${metadata.generator ? `<generator uri="https://github.com/tgel0/crssnt" version="1.0">${escapeXmlMinimal(metadata.generator)}</generator>\n` : ''}${entryXmlStrings}\n</feed>`;
}


function generateJsonFeedObject(feedData, groupByFeedInternal = false, multipleSources = false, isLlmCompact = false) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
        console.error("Invalid feedData passed to generateJsonFeedObject");
        return { version: "https://jsonfeed.org/version/1.1", title: "Error Generating Feed", items: [] };
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
            id: isLlmCompact ? undefined : itemId, 
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
       const itemStrings = [];
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

           for (const sourceKey in groupedItems) {
               const group = groupedItems[sourceKey];
               let groupString = `# ${group.title}`; 
               const groupItemStrings = [];
               group.items.forEach(item => {
                   let itemStr = `## ${item.title || '(Untitled)'}`;
                   const cleanDescription = String(item.descriptionContent || '').replace(/\n+/g, ' ').trim();
                   if (cleanDescription) {
                       itemStr += ` ${cleanDescription}`;
                   }
                   if (item.link) itemStr += ` Link: ${item.link}`;
                   if (item.dateObject && isValid(item.dateObject)) itemStr += ` Date: ${formatISO(item.dateObject)}`;
                   groupItemStrings.push(itemStr);
               });
               groupString += " " + groupItemStrings.join(" --- "); 
               itemStrings.push(groupString);
           }
       } else { 
           items.forEach(item => {
               let itemStr = `# ${item.title || '(Untitled)'}`;
               const cleanDescription = String(item.descriptionContent || '').replace(/\n+/g, ' ').trim();
               if (cleanDescription) {
                   itemStr += ` ${cleanDescription}`;
               }
               if (item.link) itemStr += ` Link: ${item.link}`;
               if (item.dateObject && isValid(item.dateObject)) itemStr += ` Date: ${formatISO(item.dateObject)}`;
               itemStrings.push(itemStr);
           });
       }
       md = itemStrings.join(" ||| "); 

       if (metadata.itemCountLimited || metadata.itemCharLimited) { 
           md += " [TRUNCATED]";
       }
       return md.trim();
   }

   // Regular Markdown output 
   md += `# ${escapeMarkdown(metadata.title || 'Untitled Feed')}\n\n`;
   if (metadata.link) md += `**Source (Combined View):** [${escapeMarkdown(metadata.link)}](${escapeMarkdown(metadata.link)})\n`;
   if (metadata.feedUrl) md += `**Feed URL (This Feed):** [${escapeMarkdown(metadata.feedUrl)}](${escapeMarkdown(metadata.feedUrl)})\n`;
   if (metadata.description) md += `\n*${escapeMarkdown(metadata.description)}*\n`;
    if (metadata.itemCountLimited || metadata.itemCharLimited) { 
        md += `\n**Note: Feed content may be truncated due to limits.**\n`;
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
               group.items.forEach(item => md += renderMarkdownItem(item, false)); 
           }
       } else {
           items.forEach(item => md += renderMarkdownItem(item, false)); 
       }
   }
   return md;
}

function renderMarkdownItem(item, isLlmCompact = false) {
    if (isLlmCompact) { 
        let itemStr = `${item.title || '(Untitled)'} - ${String(item.descriptionContent || '').replace(/\n+/g, ' ')}`;
        if (item.link) itemStr += ` (${item.link})`;
        if (item.dateObject && isValid(item.dateObject)) itemStr += ` [${formatISO(item.dateObject)}]`;
        return itemStr;
    }

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
    const statusCode = 410; 
    let placeholderFeed = '', contentType = '';
    const placeholderTitle = "Feed Unavailable";
    const placeholderDesc = `The requested Google Sheet (ID: ${sheetID}) is currently unavailable or has been blocked by the administrator.`;
    const placeholderLink = 'https://crssnt.com/'; 
    if (outputFormat === 'atom') {
        contentType = 'application/atom+xml; charset=utf8';
        const updated = formatISO(new Date());
        const feedId = `urn:crssnt:blocked:${sheetID}`;
        placeholderFeed = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${escapeXmlMinimal(placeholderTitle)}</title><link href="${escapeXmlMinimal(placeholderLink)}" rel="alternate"/><id>${escapeXmlMinimal(feedId)}</id><updated>${updated}</updated><subtitle>${escapeXmlMinimal(placeholderDesc)}</subtitle><entry><title>Sheet Unavailable</title><id>${escapeXmlMinimal(feedId)}:entry:${Date.now()}</id><updated>${updated}</updated><content type="text">${escapeXmlMinimal(placeholderDesc)}</content></entry></feed>`;
    } else { 
        contentType = 'application/rss+xml; charset=utf8';
        const pubDate = format(new Date(), "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' }); 
        placeholderFeed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXmlMinimal(placeholderTitle)}</title><link>${escapeXmlMinimal(placeholderLink)}</link><description>${escapeXmlMinimal(placeholderDesc)}</description><lastBuildDate>${pubDate}</lastBuildDate><item><title>Sheet Unavailable</title><description>${escapeXmlMinimal(placeholderDesc)}</description><pubDate>${pubDate}</pubDate><guid isPermaLink="false">unavailable-${escapeXmlMinimal(sheetID)}-${Date.now()}</guid></item></channel></rss>`;
    }
    return { feedXml: placeholderFeed, contentType, statusCode };
}

module.exports = {
    getSheetData, buildFeedData, fetchUrlContent, parseXmlFeedWithCheerio,
    normalizeParsedFeed, processMultipleUrls, generateRssFeed, generateAtomFeed,
    generateJsonFeedObject, generateMarkdown, generateBlockedFeedPlaceholder,
    escapeMarkdown, escapeXmlMinimal
};
