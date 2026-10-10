# Architecture Decision Records

One file per decision, numbered `NNNN-short-title.md`, never renumbered and never deleted: a
superseded decision gets a new ADR that says so.

Format: **Context** (what forced a choice) → **Decision** (what we chose, in the imperative) →
**Consequences** (what it buys, what it costs, what it forecloses) → **Alternatives considered**
(including "do nothing" and why not). Keep the measured numbers in the file — a decision record
whose evidence is a claim nobody can re-run is not a record.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-domain-repositories.md) | Split `MetadataStore` into domain repositories | Accepted — Phase 1 landed (audio-feed-d9sl) |
