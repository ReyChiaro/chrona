import { LocalizedError } from '../../i18n/src/index';
import { msg } from '../../i18n/src/index';
import ts from 'typescript';
import { contentPackageSchema, packageKey, editPlanSchema, selectionSchema, storedObjectSchema, type ContentPackage } from '../../protocol/src/content';
import { configSchema } from '../../protocol/src/config';
import { generateContentChunk, WorldContent } from '../../world/src/content';
import { evaluateRegion } from '../../world/src/region-validation';
import { generateChunk } from '../../world/src/generator';
import { hexDisk } from '../../world/src/hex';
import { materialBindings } from '../../protocol/src/materials';
import { requestsWater, waterTileAssets } from '../../world/src/water-validation';

/** Parse data-only TypeScript. No evaluation, imports, IO, callbacks or engine replacement. */
export function compilePlugin(source: string): ContentPackage {
  if (source.length > 100000) throw new LocalizedError('proxy.compiler.the-plugin-source-exceeds-the-size-limit');
  const diagnostics = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics ?? [];
  if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) throw new LocalizedError('proxy.compiler.the-plugin-contains-invalid-typescript-syntax');
  const file = ts.createSourceFile('plugin.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = file.statements;
  if (statements.length !== 1 || !ts.isExportAssignment(statements[0])) throw new LocalizedError('proxy.compiler.the-protocol-requires-exactly-one-export-default-definecontent');
  const call = statements[0].expression;
  if (!ts.isCallExpression(call) || call.expression.getText(file) !== 'defineContent' || call.arguments.length !== 1) throw new LocalizedError('proxy.compiler.only-definecontent-may-be-called');
  const literal = (node: ts.Node): unknown => {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new LocalizedError('proxy.compiler.only-literal-properties-are-allowed');
        const name = property.name.text;
        if (['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(result, name)) throw new LocalizedError('proxy.compiler.duplicate-or-invalid-property');
        result[name] = literal(property.initializer);
      }
      return result;
    }
    throw new LocalizedError('proxy.compiler.plugins-may-contain-only-data-literals-executable-expressions-are');
  };
  return contentPackageSchema.parse(literal(call.arguments[0]));
}

export function validatePackage(pack: ContentPackage, input: unknown = {}, context: { protectedChunks?: string[]; prompt?: string } = {}) {
  const config = configSchema.parse(input);
  if (requestsWater(context.prompt ?? '') && !pack.region?.water && (pack.region || waterTileAssets(pack).length)) throw new LocalizedError('proxy.compiler.water-scenes-require-protocol-2-and-region-water-read');
  // Resolve bindings with the same function as the renderer and context buffer.
  const materials = Object.entries(pack.assets).map(([asset, recipe]) => ({ asset, bindings: materialBindings(recipe),
    unused: Object.keys(recipe.materials ?? {}).filter(id => !recipe.parts.some(part => 'material' in part && part.material === id)) }));
  for (const [assetName, recipe] of Object.entries(pack.assets)) {
    for (const part of recipe.parts) {
      if (part.size.some(v => v <= 0 || v > 32) || part.position.some(v => Math.abs(v) > 32)) throw new LocalizedError('proxy.compiler.the-asset-exceeds-the-32-metre-part-envelope');
    }
    if (recipe.collider && (recipe.collider.halfExtents.some(v => v <= 0 || v > 8) || recipe.collider.center.some(v => Math.abs(v) > 16))) throw new LocalizedError('proxy.compiler.the-collider-exceeds-safe-dimensions');
    for (const collider of [...(recipe.collider ? [recipe.collider] : []), ...(recipe.colliders ?? [])]) for (let axis = 0; axis < 3; axis++) {
      const low = Math.min(...recipe.parts.map(p => p.position[axis] - p.size[axis] / 2));
      const high = Math.max(...recipe.parts.map(p => p.position[axis] + p.size[axis] / 2));
      if (collider.center[axis] - collider.halfExtents[axis] < low - 0.05 || collider.center[axis] + collider.halfExtents[axis] > high + 0.05) throw new LocalizedError('proxy.compiler.asset-collider-exceeds-the-visible-envelope-axis-must-stay', { p0: assetName, p1: ['x', 'y', 'z'][axis], p2: low.toFixed(2), p3: high.toFixed(2) });
    }
  }
  if (pack.terrain?.scatterAsset && !pack.assets[pack.terrain.scatterAsset]) throw new LocalizedError('proxy.compiler.the-scatter-rule-references-a-missing-asset');
  if (pack.region) {
    const content = new WorldContent(); content.deployRegion(pack, context.protectedChunks ?? [], 0);
    const completion = evaluateRegion(content, pack, config, context.prompt);
    if (completion.status === 'failed') throw new LocalizedError('proxy.compiler.actual-region-generation-validation-failed', { p0: completion.failures.slice(0, 12).join('；') });
    return { passed: true, checks: ['data-only-source', 'schema', 'asset-envelope', 'collider-envelope', 'material-bindings', 'regional-generation', 'actual-layout', 'drivable-roads', 'world-time-motion', 'requested-feature-criteria', ...(pack.region.water ? ['native-water-surface', 'water-connectivity', 'shore-contact', 'submerged-habitat'] : [])],
      cells: completion.chunks, boundarySamples: 0, collisionTriangles: completion.chunks * config.subdivisions ** 2 * 6, completion, materials };
  }
  const cells = hexDisk({ q: 0, r: 0 }, 2);
  let samples = 0, triangles = 0;
  for (const cell of cells) {
    const base = generateChunk(cell, config), a = generateContentChunk(cell, config, [pack]), b = generateContentChunk(cell, config, [pack]);
    if (a.fingerprint !== b.fingerprint) throw new LocalizedError('proxy.compiler.repeated-generation-is-not-deterministic');
    if (JSON.stringify(a.boundary) !== JSON.stringify(base.boundary)) throw new LocalizedError('proxy.compiler.the-plugin-changed-the-boundary-contract');
    for (let i = 0; i < a.positions.length; i += 3) if (base.boundary.some(b => Math.abs(b.x - a.positions[i]) < 1e-4 && Math.abs(b.z - a.positions[i + 2]) < 1e-4)) {
      if (a.positions[i + 1] !== base.positions[i + 1] || [0, 1, 2].some(j => a.colors[i + j] !== base.colors[i + j])) throw new LocalizedError('proxy.compiler.the-generated-mesh-or-colors-violate-the-boundary-contract');
    }
    if (![...a.positions].every(Number.isFinite)) throw new LocalizedError('proxy.compiler.terrain-contains-non-finite-values');
    for (const index of a.indices) if (index >= a.positions.length / 3) throw new LocalizedError('proxy.compiler.a-collision-mesh-index-is-out-of-bounds');
    samples += a.boundary.length; triangles += a.indices.length / 3;
  }
  return { passed: true, checks: ['data-only-source', 'schema', 'asset-envelope', 'collider-envelope', 'material-bindings', 'determinism', 'unchanged-seams-and-colors', 'finite-collision-mesh'], cells: cells.length, boundarySamples: samples, collisionTriangles: triangles, materials };
}

