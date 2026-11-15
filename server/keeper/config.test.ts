/**
 * The one secret: read once, never echoed, gone from the environment after.
 */

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { readSigner } from './config';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('readSigner', () => {
  it('derives the account and removes the key from the environment', () => {
    const env: Record<string, string | undefined> = { KEEPER_PRIVATE_KEY: KEY };
    const result = readSigner(env);
    expect(result.account?.address).toBe(privateKeyToAccount(KEY).address);
    expect(env.KEEPER_PRIVATE_KEY).toBeUndefined();
  });

  it('accepts a key without 0x', () => {
    expect(readSigner({ KEEPER_PRIVATE_KEY: KEY.slice(2) }).account?.address).toBe(privateKeyToAccount(KEY).address);
  });

  it('says why there is no signer when the key is missing', () => {
    const result = readSigner({});
    expect(result.account).toBeNull();
    expect(result.problem).toMatch(/KEEPER_PRIVATE_KEY is not set/);
  });

  it('describes a malformed key by its shape and never quotes it', () => {
    const bad = '0xdeadbeefcafe' + 'z'.repeat(52);
    const env: Record<string, string | undefined> = { KEEPER_PRIVATE_KEY: bad };
    const result = readSigner(env);
    expect(result.account).toBeNull();
    expect(result.problem).toMatch(/not a 32-byte hex key/);
    expect(result.problem).not.toContain('deadbeef');
    expect(result.problem).not.toContain('zzzz');
    expect(env.KEEPER_PRIVATE_KEY).toBeUndefined();
  });
});
