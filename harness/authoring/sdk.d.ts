import type { ContentPackage } from '../../packages/protocol/src/content';
/** Literal data only; no executable callbacks. */
declare global { function defineContent(recipe: ContentPackage): ContentPackage; }
export {};
