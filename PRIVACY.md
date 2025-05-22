# Privacy Policy for crssnt

**Last Updated:** October 2023

Thank you for using `crssnt`! This Privacy Policy explains how `crssnt` handles information when you use the service.

## Information We Process

`crssnt` is designed to be a stateless service for generating and converting RSS feeds.

*   **URLs Provided by You:** When you use `crssnt` to generate a feed from a Google Sheet or convert an existing feed, you provide a URL. `crssnt` fetches data from this URL to perform the requested operation.
    *   **Google Sheets:** If you provide a URL for a Google Sheet, `crssnt` accesses the CSV data published to the web from that sheet. `crssnt` only accesses data that you have explicitly made public via Google's "Publish to web" feature.
    *   **External Feeds:** If you provide a URL for an existing RSS, Atom, or JSON feed, `crssnt` fetches the content from that URL.
*   **Query Parameters:** `crssnt` uses query parameters you provide (e.g., for mapping columns in a Google Sheet or specifying output format) to customize the feed generation or conversion process.

## Data Storage and Retention

`crssnt` **does not store** any of the content from the URLs you provide or the feeds it generates after the request is completed. It acts as a transient processor.

*   The data is fetched, processed in memory, and then sent back to you as the resulting feed.
*   No part of the Google Sheet data or external feed content is saved to a database or permanent storage by `crssnt` itself.

## Logging

Like most web services, `crssnt` (when deployed, for example, as a Firebase Cloud Function) may have logging enabled by the hosting platform (e.g., Google Cloud Firebase). This logging is typically used for:

*   Monitoring the health and performance of the service.
*   Debugging issues.
*   Security purposes.

These logs may contain information such as:

*   The URLs requested.
*   IP addresses making the requests.
*   Request timestamps.
*   Status codes.
*   User-agent strings.

This logging is subject to the privacy policy of the hosting provider (e.g., Google Cloud). `crssnt` itself does not implement additional logging of feed content.

## Data Sharing

`crssnt` does not share the content of your feeds or the source data with any third parties. The only data transfer that occurs is:

*   Fetching data from the URL you provide.
*   Returning the generated/converted feed to you.

## Security

We take reasonable steps to protect the information processed by `crssnt`. However, as `crssnt` operates on data fetched from user-provided public URLs, the security of the source data itself is your responsibility (e.g., ensuring your Google Sheet sharing settings are appropriate).

## Children's Privacy

`crssnt` is not intended for use by children under the age of 13. We do not knowingly collect any personally identifiable information from children under 13.

## Changes to This Privacy Policy

We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page. You are advised to review this Privacy Policy periodically for any changes.

## Contact Us

If you have any questions about this Privacy Policy, please open an issue on the GitHub repository.
