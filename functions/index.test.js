const { generateFeedContent, generateFeedAutoMode } = require('./index'); // Adjust path if needed

describe('generateFeedContent (Auto Mode)', () => {
  it('should call generateFeedAutoMode when mode is not "manual"', () => {
    const values = [['My Title', 'My Description', 'https://example.com', '2023-10-27']];
    const { xmlItems, feedDescription } = generateFeedContent(values, 'auto');
    expect(feedDescription).toContain('auto mode');
    // Basic check for item structure
    expect(xmlItems).toContain('<item>');
    expect(xmlItems).toContain('</item>');
  });
});

describe('generateFeedAutoMode', () => {
  it('should generate XML items from valid data', () => {
    const values = [
      ['Title 1', 'Description 1', 'https://example.com/1', '2023-10-26'],
      ['Title 2', 'Description 2', 'https://example.com/2', '2023-10-27'],
    ];
    const result = generateFeedAutoMode(values);
    // Check for basic item structure
    expect(result).toContain('<item>');
    expect(result).toContain('</item>');
    // Check for some basic tags
    expect(result).toContain('<title>');
    expect(result).toContain('<description>');
    expect(result).toContain('<pubDate>');
  });

  it('should handle missing URL and date', () => {
    const values = [['Title 3', 'Description 3']];
    const result = generateFeedAutoMode(values);
    // Check for basic item structure
    expect(result).toContain('<item>');
    expect(result).toContain('</item>');
    // Check for some basic tags
    expect(result).toContain('<title>');
    expect(result).toContain('<description>');
    expect(result).toContain('<pubDate>');
  });

  it('should handle empty values', () => {
    const values = [];
    const result = generateFeedAutoMode(values);
    expect(result).toBe('');
  });

  it('should handle multiple values', () => {
    const values = [
      ['Title 1', 'Description 1', 'https://example.com/1', '2023-10-26'],
      ['Title 2', 'Description 2', 'https://example.com/2', '2023-10-27'],
      ['Title 3', 'Description 3', 'https://example.com/3', '2023-10-28'],
    ];
    const result = generateFeedAutoMode(values);
    expect(result.match(/<item>/g).length).toBe(3);
  });

  it('should handle values with no description', () => {
    const values = [['Title 1', 'https://example.com/1', '2023-10-26']];
    const result = generateFeedAutoMode(values);
    expect(result).toContain('<item>');
    expect(result).toContain('</item>');
    expect(result).toContain('<title>');
    expect(result).toContain('<pubDate>');
  });
});
