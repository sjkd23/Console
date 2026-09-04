import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const botRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(botRoot, 'src');
const runtimeExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

function sourceFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
}

function moduleSpecifiers(sourceFile) {
    const found = [];

    function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            found.push({ node: node.moduleSpecifier, value: node.moduleSpecifier.text });
        } else if (
            ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments.length === 1
            && ts.isStringLiteral(node.arguments[0])
        ) {
            found.push({ node: node.arguments[0], value: node.arguments[0].text });
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return found;
}

function exactCasePathExists(path) {
    const absolute = resolve(path);
    const parsedRoot = resolve(absolute, sep);
    const segments = relative(parsedRoot, absolute).split(sep).filter(Boolean);
    let current = parsedRoot;

    for (const segment of segments) {
        const entries = readdirSync(current);
        if (!entries.includes(segment)) return false;
        current = join(current, segment);
    }

    return true;
}

function sourceTarget(importer, specifier) {
    const runtimePath = resolve(dirname(importer), specifier);
    const extension = extname(runtimePath);
    const candidates = extension === '.js'
        ? [`${runtimePath.slice(0, -3)}.ts`, `${runtimePath.slice(0, -3)}.tsx`]
        : [runtimePath];

    for (const candidate of candidates) {
        try {
            if (statSync(candidate).isFile()) return candidate;
        } catch {
            // Continue to the next TypeScript source candidate.
        }
    }
    return null;
}

const invalid = [];
let relativeImportCount = 0;

for (const filename of sourceFiles(sourceRoot)) {
    const sourceText = ts.sys.readFile(filename);
    if (sourceText === undefined) throw new Error(`Unable to read ${filename}`);
    const sourceFile = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true);

    for (const { node, value } of moduleSpecifiers(sourceFile)) {
        if (!value.startsWith('./') && !value.startsWith('../')) continue;
        relativeImportCount += 1;
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const displayFile = relative(botRoot, filename).split(sep).join('/');
        const prefix = `${displayFile}:${location.line + 1}`;

        if (!runtimeExtensions.has(extname(value))) {
            invalid.push(`${prefix}: relative ESM specifier must include a runtime extension: ${value}`);
            continue;
        }

        const target = sourceTarget(filename, value);
        if (target === null) {
            invalid.push(`${prefix}: relative ESM target does not exist: ${value}`);
        } else if (!exactCasePathExists(target)) {
            invalid.push(`${prefix}: relative ESM target casing does not match the filesystem: ${value}`);
        }
    }
}

if (invalid.length > 0) {
    console.error(`Found ${invalid.length} invalid relative ESM specifier(s) among ${relativeImportCount} relative import/export specifier(s):`);
    for (const issue of invalid) console.error(issue);
    process.exit(1);
}

console.log(`Validated ${relativeImportCount} relative ESM import/export specifier(s), including exact filename casing.`);
