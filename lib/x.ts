/** An X post composer, prefilled: the text, and a link X unfurls as the page's card. */
export function xPostHref(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
