'use client';

import { useEffect, useState } from 'react';

/**
 * The browser's clock, or null during the server render and the first client
 * render — so anything worded from "now" ("live · 35s ago") renders the same
 * HTML on both sides and appears once mounted, instead of failing hydration.
 * Ticks every `ms`.
 */
export function useNow(ms = 10_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
