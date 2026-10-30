# Evidence: audio-feed-icl4

- Script: scripts/repro_icl4_nonok_body_read.ts
- Asserts: a deadline that fires while reading a non-2xx error body is named in the persisted episode error (`timed out after 200ms while reading the error response body`) while the provider status is kept, and a caller abort during that same read surfaces the raw abort reason instead of being dressed up as a provider 503. `repro.json` is the record of the run.
