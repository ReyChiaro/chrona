import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import ts from "typescript";

const en: Record<string, string> = JSON.parse(
  await readFile("locales/en.json", "utf8"),
);
const zh: Record<string, string> = JSON.parse(
  await readFile("locales/zh-Hans.json", "utf8"),
);
assert.deepEqual(
  Object.keys(en).sort(),
  Object.keys(zh).sort(),
  "Language catalog keys differ",
);
for (const [key, text] of Object.entries(en)) {
  assert.ok(text.trim() && zh[key]?.trim(), `Empty translation: ${key}`);
  assert.ok(
    !/[\u3400-\u9fff]/.test(text),
    `Chinese text in English catalog: ${key}`,
  );
  assert.deepEqual(
    text.match(/\{[a-zA-Z]\w*\}/g)?.sort(),
    zh[key].match(/\{[a-zA-Z]\w*\}/g)?.sort(),
    `Parameter mismatch: ${key}`,
  );
}
async function files(directory: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((item) =>
        item.isDirectory()
          ? files(directory + "/" + item.name)
          : [directory + "/" + item.name],
      ),
    )
  ).flat();
}
let references = 0;
for (const directory of ["apps", "packages", "contracts/schemas", "src/chrona"])
  for (const file of await files(directory)) {
    if (!/\.(ts|py|js|html)$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(
      /\b(?:t|msg|tr)\(['"]([a-z][\w.-]+)['"]/g,
    )) {
      assert.ok(match[1] in en, `${file}: missing ${match[1]}`);
      references++;
    }
    for (const match of source.matchAll(
      /data-i18n(?:-(?:aria-label|title|alt|placeholder|data-title))?="([\w.-]+)"/g,
    ))
      assert.ok(match[1] in en, `${file}: missing ${match[1]}`);
    // Interface literals belong in catalogs. Input-language lexicons remain in
    // domain parsers, and language names are intentionally written as autonyms.
    if (file.startsWith("apps/web/") && file.endsWith(".ts")) {
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)) &&
          /[\u3400-\u9fff]/.test(node.text)
        )
          throw new Error(
            `${file}: hardcoded UI text: ${node.text.slice(0, 80)}`,
          );
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  }
console.log(
  `i18n: ${Object.keys(en).length} bilingual messages, ${references} source references, no hardcoded Chinese UI literals.`,
);
