# Version contracts

`versions.json` is generated from the canonical schemas. Object-only recipes use protocol 1; regional recipes use protocol 2. Content parts reference named materials. Global terrain overlays and inline material parts are unsupported.

World checkpoints require the matching Rapier version and build. Restoring metadata-only snapshots is unsupported. Only current job records under the route workspace are exposed by `/api/render/jobs`.

Language descriptors are part of the current response format. They preserve user text while allowing the interface and current task records to switch languages.
