import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateRawSync, crc32} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {
  assertExistingFileWithin,
  boundEvidence,
  limits,
  literal,
  readUtf8File,
  references,
  textWindow,
  within
} from '../evidence.mjs';
import {listArchiveEntries, readArchiveEntry} from '../archive-store.mjs';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-evidence-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const source = Buffer.from(item.data);
    const method = item.method ?? 0;
    const packed = method === 8 ? deflateRawSync(source) : source;
    const checksum = crc32(source);
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + packed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function archiveExec(root) {
  const resolvedRoot = path.resolve(root);
  const assertInside = file => {
    const relative = path.relative(resolvedRoot, path.resolve(file));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Path resolves outside the current workspace'), {
        code: 'FS_OUTSIDE_WORKSPACE'
      });
    }
  };
  const stat = async (_root, file) => {
    assertInside(file);
    try {
      const info = await fs.stat(file);
      return {
        path: file,
        target: file,
        exists: true,
        type: info.isFile() ? 'file' : 'directory',
        version: `${info.mtimeMs}:${info.size}`,
        bytes: info.size
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {path: file, target: file, exists: false, type: null, version: null, bytes: null};
      }
      throw error;
    }
  };
  const readBytes = async (_root, file, _signal, maxBytes) => {
    const info = await stat(_root, file);
    if (!info.exists) throw Object.assign(new Error('Source file is unavailable'), {code: 'FS_NOT_FOUND'});
    if (info.bytes > maxBytes) throw Object.assign(new Error('File exceeds read budget'), {code: 'FS_READ_BUDGET'});
    const bytes = await fs.readFile(file);
    return {
      path: file,
      bytes,
      version: info.version,
      bytesLength: bytes.length,
      versioned: true
    };
  };

  return {
    agent: {sessionId: `archive-test-${randomUUID()}`},
    nativeFiles: {stat, readBytes}
  };
}

async function makeArchive(t, entries) {
  const directory = await temporaryDirectory(t);
  const archive = 'fixture.zip';
  await fs.writeFile(path.join(directory, archive), buildZip(entries));
  return {directory, archive, exec: archiveExec(directory)};
}

test('within resolves paths inside the workspace', () => {
  const root = path.join(os.tmpdir(), 'dsh-evidence-root');
  assert.equal(within(root, 'src/main.mjs'), path.resolve(root, 'src/main.mjs'));
  assert.equal(
    within(root, path.join(root, 'nested', 'file.java')),
    path.join(root, 'nested', 'file.java')
  );
  assert.equal(within(root, '.'), path.resolve(root));
});

test('within rejects traversal and absolute paths outside the workspace', () => {
  const root = path.join(os.tmpdir(), 'dsh-evidence-root');
  const outside = path.join(path.dirname(root), 'outside.mjs');

  assert.throws(() => within(root, '../outside.mjs'), /inside the current workspace/);
  assert.throws(() => within(root, path.join('src', '..', '..', 'outside.mjs')), /inside/);
  assert.throws(() => within(root, outside), /inside/);
  assert.throws(() => within(root, path.parse(root).root), /inside/);
});

test('within rejects malformed path inputs', () => {
  const root = path.join(os.tmpdir(), 'dsh-evidence-root');
  assert.throws(() => within(root, ''), /Invalid path/);
  assert.throws(() => within(root, '   '), /Invalid path/);
  assert.throws(() => within(root, 'a\0b'), /Invalid path/);
  assert.throws(() => within(root, 'a'.repeat(1025)), /Invalid path/);
});

test('assertExistingFileWithin accepts a regular file and rejects outside paths or directories', async t => {
  const parent = await temporaryDirectory(t);
  const root = path.join(parent, 'root');
  const inside = path.join(root, 'inside.txt');
  const outside = path.join(parent, 'outside.txt');
  await fs.mkdir(root);
  await fs.writeFile(inside, 'inside');
  await fs.writeFile(outside, 'outside');

  const accepted = await assertExistingFileWithin(root, inside);
  assert.equal(accepted.size, 6);
  assert.equal(accepted.real, await fs.realpath(inside));
  await assert.rejects(
    assertExistingFileWithin(root, outside),
    /outside the current workspace/
  );
  await assert.rejects(
    assertExistingFileWithin(root, root),
    /not a regular file/
  );
});

test('readUtf8File returns bytes and rejects oversized or non-UTF-8 data', async t => {
  const directory = await temporaryDirectory(t);
  const valid = path.join(directory, 'valid.txt');
  const invalid = path.join(directory, 'invalid.bin');
  const text = 'hello 世界';
  await fs.writeFile(valid, text);
  await fs.writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfd]));

  const source = await readUtf8File(valid, {maxBytes: Buffer.byteLength(text)});
  assert.equal(source.text, text);
  assert.equal(source.bytes, Buffer.byteLength(text));
  assert.match(source.sha256, /^[a-f0-9]{64}$/);

  await assert.rejects(
    readUtf8File(valid, {maxBytes: Buffer.byteLength(text) - 1}),
    /read budget/
  );
  await assert.rejects(readUtf8File(invalid), /not valid UTF-8/);
});

test('literal escapes every regex metacharacter', () => {
  const value = 'a+b?(c)[d]{e}^$|\\';
  const pattern = new RegExp('^' + literal(value) + '$');

  assert.equal(pattern.test(value), true);
  assert.equal(pattern.test(value + '!'), false);
  assert.equal(literal('.'), '\\.');
});

test('textWindow truncates by line count and line width with complete locators', () => {
  const window = textWindow({
    path: 'src/main.mjs',
    lines: [
      {number: 1, text: 'abcdef'},
      {number: 2, text: 'ok'},
      {number: 3, text: 'last'}
    ],
    totalLines: 3
  }, {maxLines: 2, maxLineChars: 4});

  assert.deepEqual(window.lines, [
    {line: 1, text: 'abcd', lineTextTruncated: true},
    {line: 2, text: 'ok'}
  ]);
  assert.equal(window.lineTextTruncated, true);
  assert.equal(window.linesTruncated, true);
  assert.equal(window.fileHasMore, true);
  assert.equal(window.truncated, true);
});

test('textWindow leaves complete boundaries untruncated and marks budget truncation', () => {
  const complete = textWindow({
    path: 'src/small.mjs',
    lines: [
      {number: 1, text: 'abc'},
      {number: 2, text: 'de'}
    ],
    totalLines: 2
  }, {maxLines: 2, maxLineChars: 3});
  assert.equal(complete.lineTextTruncated, false);
  assert.equal(complete.linesTruncated, false);
  assert.equal(complete.fileHasMore, false);
  assert.equal(complete.truncated, false);

  const budget = textWindow({
    path: 'src/budget.mjs',
    lines: [{number: 1, text: 'abc'}],
    totalLines: 1,
    truncatedByBytes: true
  });
  assert.equal(budget.budgetTruncated, true);
  assert.equal(budget.truncated, true);
  assert.equal(textWindow(null), null);
});

test('boundEvidence deduplicates exact matches and failure records', () => {
  const searchMatch = {path: 'src/a.mjs', line: 4, text: 'hit'};
  const reference = {file: 'src/a.mjs', line: 4};
  const facts = {
    search: {matches: [searchMatch, {...searchMatch}]},
    entryMatches: {matches: [searchMatch, searchMatch]},
    references: {matches: [reference, {...reference}]},
    failures: [
      {tool: 'grep', detail: 'same failure'},
      {tool: 'grep', detail: 'same failure'}
    ],
    sources: []
  };

  const bounded = boundEvidence(facts, 10000);
  assert.equal(bounded.search.matches.length, 1);
  assert.equal(bounded.search.matches[0].repeatCount, 2);
  assert.equal(bounded.search.exactDuplicatesRemoved, 1);
  assert.equal(bounded.entryMatches.matches.length, 1);
  assert.equal(bounded.entryMatches.matches[0].repeatCount, 2);
  assert.equal(bounded.references.matches.length, 1);
  assert.equal(bounded.references.matches[0].repeatCount, 2);
  assert.equal(bounded.failures.length, 1);
});

test('boundEvidence enforces its character budget and marks dropped matches', () => {
  const facts = {
    mode: 'read',
    workspace: 'workspace',
    sources: [],
    references: {
      matches: Array.from({length: 20}, (_, index) => ({
        file: `src/File${index}.java`,
        line: index + 1,
        preview: 'x'.repeat(80)
      }))
    }
  };

  const bounded = boundEvidence(facts, 300);
  assert.ok(JSON.stringify(bounded).length <= 300);
  assert.equal(bounded.references.truncated, true);
  assert.ok(bounded.references.matches.length < 20);
});

test('references extracts supported locators, ignores invalid lines and caps results', () => {
  const found = references(
    'C:/src/A.java:12 src/B.mjs:7 Foo.java:3 src/C.ts:8 Foo.java:0 missing'
  );

  assert.deepEqual(found, [
    {file: 'C:/src/A.java', line: 12},
    {file: 'src/B.mjs', line: 7},
    {file: 'Foo.java', line: 3},
    {file: 'src/C.ts', line: 8}
  ]);
  assert.equal(found.length, limits.files);
  assert.deepEqual(references('no locator here'), []);
});

test('archive listing reads stored and deflated entries and manifest text', async t => {
  const fixture = await makeArchive(t, [
    {name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n'},
    {name: 'stored.txt', data: 'alpha\nbeta\n'},
    {name: 'pkg/Widget.java', data: 'class Widget {}\n'.repeat(8), method: 8}
  ]);

  const listed = await listArchiveEntries(
    fixture.directory,
    fixture.archive,
    fixture.exec
  );

  assert.equal(listed.state, 'observed');
  assert.deepEqual(listed.entries, [
    'META-INF/MANIFEST.MF',
    'stored.txt',
    'pkg/Widget.java'
  ]);
  assert.equal(listed.manifestText, 'Manifest-Version: 1.0\n');
});

test('missing archive dependency is named and the same module becomes usable after dependency repair',async t=>{
  const fixture=await makeArchive(t,[{name:'source.txt',data:'exact archive source\n',method:8}]);
  const isolated=await temporaryDirectory(t),modulePath=path.join(isolated,'archive-store.mjs');
  await fs.writeFile(modulePath,await fs.readFile(new URL('../archive-store.mjs',import.meta.url)));
  const isolatedArchive=await import(pathToFileURL(modulePath).href);
  const missing=isolatedArchive.archiveDecoderStatus();
  assert.equal(missing.available,false);assert.equal(missing.code,'ARCHIVE_DECODER_UNAVAILABLE');assert.match(missing.message,/fflate/);
  const unavailable=await isolatedArchive.readArchiveEntry(fixture.directory,fixture.archive,'source.txt',fixture.exec);
  assert.equal(unavailable.code,'ARCHIVE_DECODER_UNAVAILABLE');
  const installed=path.dirname(path.dirname(createRequire(import.meta.url).resolve('fflate')));
  await fs.mkdir(path.join(isolated,'node_modules'));
  await fs.symlink(installed,path.join(isolated,'node_modules','fflate'),'junction');
  assert.equal(isolatedArchive.archiveDecoderStatus().available,true);
  const available=await isolatedArchive.readArchiveEntry(fixture.directory,fixture.archive,'source.txt',fixture.exec);
  assert.equal(available.state,'observed');assert.equal(available.text,'exact archive source\n');
});

test('archive entry reading supports stored and deflate compression', async t => {
  const fixture = await makeArchive(t, [
    {name: 'stored.txt', data: 'alpha\nbeta\n'},
    {name: 'deflated.txt', data: 'repeat me\n'.repeat(40), method: 8}
  ]);

  const stored = await readArchiveEntry(
    fixture.directory,
    fixture.archive,
    'stored.txt',
    fixture.exec
  );
  assert.equal(stored.state, 'observed');
  assert.equal(stored.text, 'alpha\nbeta\n');
  assert.deepEqual(stored.lines, ['alpha', 'beta']);

  const deflated = await readArchiveEntry(
    fixture.directory,
    fixture.archive,
    'deflated.txt',
    fixture.exec
  );
  assert.equal(deflated.state, 'observed');
  assert.equal(deflated.text, 'repeat me\n'.repeat(40));
  assert.equal(deflated.lines.length, 40);
});

test('archive entries with understated decoded size are not reported as complete', async t => {
  const directory = await temporaryDirectory(t);
  const archive = 'understated.zip';
  const zip = buildZip([{name: 'source.txt', data: 'abcdefghijk', method: 8}]);
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(central, -1);
  zip.writeUInt32LE(2, 22);
  zip.writeUInt32LE(2, central + 24);
  zip.writeUInt32LE(crc32(Buffer.from('ab')), 14);
  zip.writeUInt32LE(crc32(Buffer.from('ab')), central + 16);
  await fs.writeFile(path.join(directory, archive), zip);

  const result = await readArchiveEntry(directory, archive, 'source.txt', archiveExec(directory));
  assert.equal(result.state, 'unavailable');
});

test('archive entry reads reject an incorrect checksum', async t => {
  const directory = await temporaryDirectory(t);
  for (const method of [0, 8]) {
    const archive = `checksum-${method}.zip`;
    const zip = buildZip([{name: 'source.txt', data: 'intact', method}]);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0, 14);
    zip.writeUInt32LE(0, central + 16);
    await fs.writeFile(path.join(directory, archive), zip);
    const result = await readArchiveEntry(directory, archive, 'source.txt', archiveExec(directory));
    assert.equal(result.state, 'unavailable');
    assert.equal(result.code, 'ARCHIVE_ENTRY_CHECKSUM_MISMATCH');
  }
});

test('archive entry reads reject local sizes or checksum that conflict with the directory', async t => {
  const directory = await temporaryDirectory(t);
  const cases = [
    {name: 'checksum', offset: 14},
    {name: 'compressed-size', offset: 18},
    {name: 'original-size', offset: 22}
  ];
  for (const item of cases) {
    const archive = `${item.name}.zip`;
    const zip = buildZip([{name: 'source.txt', data: 'intact', method: 8}]);
    zip.writeUInt32LE(zip.readUInt32LE(item.offset) + 1, item.offset);
    await fs.writeFile(path.join(directory, archive), zip);
    const result = await readArchiveEntry(directory, archive, 'source.txt', archiveExec(directory));
    assert.equal(result.state, 'unavailable', item.name);
  }
});

test('archive entry reads accept data descriptors after compressed data', async t => {
  const directory = await temporaryDirectory(t);
  const archive = 'descriptor.zip';
  const zip = buildZip([{name: 'source.txt', data: 'descriptor content', method: 8}]);
  const centralOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = Buffer.from(zip.subarray(0, centralOffset));
  const central = Buffer.from(zip.subarray(centralOffset, zip.length - 22));
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(central.readUInt32LE(16), 4);
  descriptor.writeUInt32LE(central.readUInt32LE(20), 8);
  descriptor.writeUInt32LE(central.readUInt32LE(24), 12);
  local.writeUInt16LE(local.readUInt16LE(6) | 8, 6);
  local.fill(0, 14, 26);
  central.writeUInt16LE(central.readUInt16LE(8) | 8, 8);
  const end = Buffer.from(zip.subarray(zip.length - 22));
  end.writeUInt32LE(centralOffset + descriptor.length, 16);
  await fs.writeFile(path.join(directory, archive), Buffer.concat([local, descriptor, central, end]));

  const result = await readArchiveEntry(directory, archive, 'source.txt', archiveExec(directory));
  assert.equal(result.state, 'observed');
  assert.equal(result.text, 'descriptor content');
});

test('archive entry reads support ZIP64 directory sizes and offsets', async t => {
  const directory = await temporaryDirectory(t);
  const archive = 'zip64.zip';
  const zip = buildZip([{name: 'source.txt', data: 'zip64 content', method: 8}]);
  const centralOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const endOffset = zip.length - 22;
  const central = Buffer.from(zip.subarray(centralOffset, endOffset));
  const compressedSize = central.readUInt32LE(20), originalSize = central.readUInt32LE(24);
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(originalSize), 4);
  extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  extra.writeBigUInt64LE(0n, 20);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt32LE(0xffffffff, 42);
  central.writeUInt16LE(extra.length, 30);
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeBigUInt64LE(1n, 24);
  zip64End.writeBigUInt64LE(1n, 32);
  zip64End.writeBigUInt64LE(BigInt(central.length + extra.length), 40);
  zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(centralOffset + central.length + extra.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.from(zip.subarray(endOffset));
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  await fs.writeFile(path.join(directory, archive), Buffer.concat([zip.subarray(0, centralOffset), central, extra, zip64End, locator, end]));

  const result = await readArchiveEntry(directory, archive, 'source.txt', archiveExec(directory));
  assert.equal(result.state, 'observed');
  assert.equal(result.text, 'zip64 content');
});

test('archive entry reads validate ZIP64 sizes in the local header', async t => {
  const directory = await temporaryDirectory(t);
  const zip = buildZip([{name: 'source.txt', data: 'zip64 local content', method: 8}]);
  const centralOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const localNameEnd = 30 + zip.readUInt16LE(26);
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(zip.readUInt32LE(22)), 4);
  extra.writeBigUInt64LE(BigInt(zip.readUInt32LE(18)), 12);
  const local = Buffer.from(zip.subarray(0, localNameEnd));
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(extra.length, 28);
  const end = Buffer.from(zip.subarray(zip.length - 22));
  end.writeUInt32LE(centralOffset + extra.length, 16);
  const contents = Buffer.concat([local, extra, zip.subarray(localNameEnd, zip.length - 22), end]);
  for (const [archive, mismatch] of [['local-zip64.zip', false], ['mismatch-zip64.zip', true]]) {
    const fixture = Buffer.from(contents);
    if (mismatch) fixture.writeBigUInt64LE(1n, localNameEnd + 4);
    await fs.writeFile(path.join(directory, archive), fixture);
    const result = await readArchiveEntry(directory, archive, 'source.txt', archiveExec(directory));
    assert.equal(result.state, mismatch ? 'unavailable' : 'observed');
    if (!mismatch) assert.equal(result.text, 'zip64 local content');
  }
});

test('legacy ZIP directories can contain 65535 entries without a ZIP64 locator', async t => {
  const directory = await temporaryDirectory(t);
  const archive = 'many-entries.zip';
  const entries = Array.from({length: 65535}, (_, index) => ({name: `${index}.txt`, data: ''}));
  await fs.writeFile(path.join(directory, archive), buildZip(entries));

  const result = await readArchiveEntry(directory, archive, '65534.txt', archiveExec(directory));
  assert.equal(result.state, 'observed');
  assert.equal(result.text, '');
});

test('an unversioned archive is reread when its contents change without a size change', async t => {
  const fixture = await makeArchive(t, [{name: 'source.txt', data: 'before'}]);
  const stat = fixture.exec.nativeFiles.stat;
  fixture.exec.nativeFiles.stat = async (...args) => ({...await stat(...args), version: null});
  const first = await readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  assert.equal(first.text, 'before');
  await fs.writeFile(path.join(fixture.directory, fixture.archive), buildZip([{name: 'source.txt', data: 'after!'}]));
  const second = await readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  assert.equal(second.state, 'observed');
  assert.equal(second.text, 'after!');
  assert.equal(second.cache.hit, false);
});

test('concurrent unversioned archive reads do not share a pending read', async t => {
  const fixture = await makeArchive(t, [{name: 'source.txt', data: 'before'}]);
  const stat = fixture.exec.nativeFiles.stat;
  let statCount = 0;
  let bothStated;
  const bothStats = new Promise(resolve => { bothStated = resolve; });
  fixture.exec.nativeFiles.stat = async (...args) => {
    const result = await stat(...args);
    if (++statCount === 2) bothStated();
    return {...result, version: null};
  };
  const readBytes = fixture.exec.nativeFiles.readBytes;
  let readCount = 0;
  let releaseReads;
  const gate = new Promise(resolve => { releaseReads = resolve; });
  fixture.exec.nativeFiles.readBytes = async (...args) => {
    readCount++;
    await gate;
    return readBytes(...args);
  };
  const reads = [
    readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec),
    readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec)
  ];
  await bothStats;
  await new Promise(resolve => setImmediate(resolve));
  releaseReads();
  const results = await Promise.all(reads);
  assert.equal(readCount, 2);
  assert.deepEqual(results.map(result => result.cache?.hit), [false, false]);
  assert.deepEqual(results.map(result => result.text), ['before', 'before']);
});

test('archive operations limit concurrent buffers and release slots after failure or cancellation', async t => {
  const fixture = await makeArchive(t, [{name: 'source.txt', data: 'before'}]);
  const stat = fixture.exec.nativeFiles.stat;
  let statCount = 0;
  let releaseSecondStat;
  const secondStatGate = new Promise(resolve => { releaseSecondStat = resolve; });
  fixture.exec.nativeFiles.stat = async (...args) => {
    if (++statCount === 2) await secondStatGate;
    return {...await stat(...args), version: null};
  };
  const readBytes = fixture.exec.nativeFiles.readBytes;
  let active = 0;
  let peak = 0;
  let started = 0;
  let signalStarted;
  const twoStarted = new Promise(resolve => { signalStarted = resolve; });
  let releaseReads;
  const gate = new Promise(resolve => { releaseReads = resolve; });
  t.after(() => releaseReads());
  fixture.exec.nativeFiles.readBytes = async (...args) => {
    active++;
    peak = Math.max(peak, active);
    const readNumber = ++started;
    if (readNumber === 1) releaseSecondStat();
    if (readNumber === 2) signalStarted();
    try {
      await gate;
      if (readNumber === 1) throw Object.assign(new Error('read failed'), {code: 'READ_FAILED'});
      return await readBytes(...args);
    } finally {
      active--;
    }
  };
  const first = readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  const second = readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  await twoStarted;
  const controller = new AbortController();
  const cancelled = readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', {...fixture.exec, signal: controller.signal});
  const last = readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(started, 2);
  controller.abort();
  await assert.rejects(cancelled, {name: 'AbortError'});
  releaseReads();
  const results = await Promise.all([first, second, last]);
  assert.equal(results[0].code, 'READ_FAILED');
  assert.equal(results[2].text, 'before');
  assert.equal(started, 3);
  assert.equal(peak, 2);
});

test('a versioned archive reuses its cached contents while its version is unchanged', async t => {
  const fixture = await makeArchive(t, [{name: 'source.txt', data: 'unchanged'}]);
  const first = await readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  const second = await readArchiveEntry(fixture.directory, fixture.archive, 'source.txt', fixture.exec);
  assert.equal(first.text, 'unchanged');
  assert.equal(second.text, 'unchanged');
  assert.equal(second.cache.hit, true);
});

test('archive entry paths normalize backslashes without allowing traversal', async t => {
  const fixture = await makeArchive(t, [
    {name: 'pkg/Widget.java', data: 'class Widget {}\n'}
  ]);

  const normalized = await readArchiveEntry(
    fixture.directory,
    fixture.archive,
    'pkg\\Widget.java',
    fixture.exec
  );
  assert.equal(normalized.state, 'observed');
  assert.equal(normalized.entry, 'pkg/Widget.java');

  for (const entry of ['../secret.txt', '/absolute.txt', 'C:/absolute.txt', 'a/../../x', '']) {
    const rejected = await readArchiveEntry(
      fixture.directory,
      fixture.archive,
      entry,
      fixture.exec
    );
    assert.equal(rejected.state, 'unavailable', entry);
    assert.equal(rejected.code, 'ARCHIVE_ENTRY_INVALID', entry);
  }
});

test('archive file paths outside the workspace are rejected by the native boundary', async t => {
  const parent = await temporaryDirectory(t);
  const root = path.join(parent, 'root');
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(parent, 'outside.zip'),
    buildZip([{name: 'secret.txt', data: 'secret'}])
  );

  const listed = await listArchiveEntries(root, '../outside.zip', archiveExec(root));
  assert.equal(listed.state, 'unavailable');
  assert.equal(listed.code, 'FS_OUTSIDE_WORKSPACE');
});

test('archive listing rejects non-archive and missing paths', async t => {
  const fixture = await makeArchive(t, []);

  const wrongExtension = await listArchiveEntries(
    fixture.directory,
    'notes.txt',
    fixture.exec
  );
  assert.equal(wrongExtension.state, 'unavailable');
  assert.equal(wrongExtension.code, 'ARCHIVE_PATH_INVALID');

  const missing = await listArchiveEntries(
    fixture.directory,
    'missing.zip',
    fixture.exec
  );
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.code, 'ARCHIVE_UNAVAILABLE');
});
