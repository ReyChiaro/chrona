/** Include shared language resources for production. */
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await cp("locales", "dist/locales", { recursive: true });
console.log("Shared language catalogs copied to dist.");
