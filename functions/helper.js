const crypto = require('crypto');
const { parseISO, isValid, format } = require('date-fns');

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


module.exports = {
    parseDateString,
    sortFeedItems,
    generateRssFeed
};