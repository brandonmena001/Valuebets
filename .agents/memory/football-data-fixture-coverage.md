---
name: Public fixture-feed coverage
description: Coverage limits of the public fixtures.csv calendar feed.
---

Treat a successful fetch with no fixtures for Premier League, La Liga, and Bundesliga as an unknown calendar, not proof that no matches exist. On 2026-10-29 UTC, fixtures.csv contained no rows for those supported divisions while OddsPapi returned upcoming events.

**Why:** The public feed can be partial while its HTTP request and CSV parsing succeed; treating an empty supported-league slice as authoritative can block odds discovery.

**How to apply:** When the filtered fixtures list is empty, retain rate-limited OddsPapi discovery. Do not infer that there are no upcoming matches.
