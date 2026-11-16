import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKEN_CA } from './site';

describe('TOKEN_CA', () => {
  // The one address the site tells people to trust. A mistyped character
  // would send buyers to someone else's contract; the checksum catches it.
  it('is a checksummed address when set', () => {
    if (TOKEN_CA === null) return;
    expect(TOKEN_CA).toBe(getAddress(TOKEN_CA));
  });
});
