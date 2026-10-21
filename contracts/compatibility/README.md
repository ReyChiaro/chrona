# Compatibility rules

`versions.json` is generated from the canonical protocol. The generator, save format, content operators and model profile evolve separately. This update preserves PCG, save format 1 and original immutable content packages.

Exact physics checkpoints are optional and require the same Rapier version and build. Older checkpoints without internal physics state restore domain state only; solver-level equivalence is not promised. Known legacy local-provider prefixes are mapped, while external providers still require explicit configuration.

Shared structures, defaults and limits come from `contracts/schemas/`. Object envelopes, references, collision and region protection are validated semantically by the World Engine and content validator. Record semantic changes and their validation explicitly. Clearing caches is not a world migration.

Language is presentation/request state. Optional message descriptors do not rename schema fields, change generator fingerprints or rewrite published content. Preserve user text and historical evidence. See `docs/I18N.md`.
