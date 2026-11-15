-- The launchpad source now follows a declared page to the image it names
-- (shockR's Imgur page). Tokens it already answered "none" for would wait out
-- their one-day retry before being asked again; ask them on the next sweep.
UPDATE tokens SET logo_retry_at = NULL
WHERE logo_url IS NULL AND logo_source IS DISTINCT FROM 'impostor';
