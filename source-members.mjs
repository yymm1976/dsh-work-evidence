import path from 'node:path';
// FastEdit's optional local parser bridge is separate from native source reads.
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {literal} from './evidence.mjs';

export const DEFAULT_LINE_TEXT_LIMIT = 1200;
export const MAX_LINE_TEXT_LIMIT = 12000;

const MAX_MEMBERS = 8;
const MAX_MEMBER_LINES = 160;
const MAX_SOURCE_BYTES = 4_000_000;
const MAX_SOURCE_LINES = 20_000;
const READ_PAGE_LINES = 200;
const FALLBACK_CONTEXT_LINES = 3;
const MAX_FALLBACK_WINDOWS = 4;
const BRIDGE_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_STDOUT_BYTES = 512 * 1024;
const MAX_BRIDGE_STDERR_BYTES = 64 * 1024;

function abortIfRequested(exec) {
  if (exec.signal?.aborted) exec.signal.throwIfAborted();
}

function wrapped(value) {
  return value?.data && typeof value.data === 'object' ? value.data : value;
}

function textOf(result) {
  return (result?.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function errorCode(result, fallback) {
  return result?.error?.info?.code
    || result?.error?.code
    || wrapped(result?.value)?.error?.code
    || result?.value?.data?.error?.code
    || fallback;
}

function requestedMembers(args) {
  const raw = Array.isArray(args.members)
    ? args.members
    : typeof args.member === 'string'
      ? [args.member]
      : [];
  if (
    !raw.length
    || raw.length > MAX_MEMBERS
    || raw.some(value =>
      typeof value !== 'string'
      || !value.trim()
      || value.length > 300
      || value.includes('\0'))
  ) {
    throw new Error('member or members must contain 1-8 member names');
  }
  return {
    plural: Array.isArray(args.members),
    names: [...new Set(raw.map(value => value.trim()))],
  };
}

export function checkedLineTextLimit(value) {
  const limit = value ?? DEFAULT_LINE_TEXT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LINE_TEXT_LIMIT) {
    throw new Error(`lineTextLimit must be an integer from 1 to ${MAX_LINE_TEXT_LIMIT}`);
  }
  return limit;
}

function checkedMemberLimit(value) {
  const limit = value ?? MAX_MEMBER_LINES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMBER_LINES) {
    throw new Error(`member limit must be an integer from 1 to ${MAX_MEMBER_LINES}`);
  }
  return limit;
}

function lineRows(lines, start, end, lineTextLimit) {
  return lines.slice(start - 1, end).map((text, index) => ({
    line: start + index,
    text: text.slice(0, lineTextLimit),
    ...(text.length > lineTextLimit ? {lineTextTruncated: true} : {}),
  }));
}

function truncationDetails(lines, start, end, lineTextLimit) {
  const selected = lines.slice(start - 1, end);
  const maxLineLength = Math.max(0, ...selected.map(line => line.length));
  const lineTextTruncated = maxLineLength > lineTextLimit;
  return {
    lineTextTruncated,
    maxLineLength,
    ...(lineTextTruncated && maxLineLength <= MAX_LINE_TEXT_LIMIT
      ? {nextLineTextLimit: maxLineLength}
      : {}),
  };
}

function limitationFor({hasMore, lineTextTruncated, canIncreaseText, prefixOmitted}) {
  if (hasMore && lineTextTruncated && !canIncreaseText) return 'member-row-range-and-line-text-maximum-limited';
  if (hasMore && lineTextTruncated) return 'member-row-range-and-line-text-limited';
  if (hasMore) return 'member-row-range-limited';
  if (lineTextTruncated && !canIncreaseText) return 'line-text-exceeds-maximum';
  if (lineTextTruncated) return 'line-text-limit';
  if (prefixOmitted) return 'member-prefix-omitted';
  return null;
}

function perMemberArguments(base, name) {
  if (Array.isArray(base.members)) return {...base, members: [name]};
  return {...base, member: name};
}

function parserSettings(options) {
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  const enabled = options.fastEditEnabled ?? options.enabled ?? config.fastEditEnabled ?? true;
  const memberParsing = options.memberParsing ?? config.memberParsing ?? true;
  const python = options.python
    || options.fastEditPython
    || config.fastEditPython
    || process.env.FASTEDIT_PYTHON
    || path.join(import.meta.dirname, '.fastedit-venv', 'Scripts', 'python.exe');
  return {
    enabled: enabled !== false,
    memberParsing: memberParsing !== false,
    python,
  };
}

function parseReceipt(stdout) {
  for (const line of String(stdout || '').trim().split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value = JSON.parse(line.trim());
      if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value;
    } catch {}
  }
  return null;
}

async function parseJavaMembers(source, names, exec, options, includeBytePositions) {
  const settings = parserSettings(options);
  if (!settings.enabled) return {ok: false, reason: 'fastedit-disabled'};
  if (!path.isAbsolute(settings.python)) return {ok: false, reason: 'fastedit-python-not-absolute'};
  const bridge = path.join(import.meta.dirname, 'source-members-bridge.py');
  try {
    await fs.access(settings.python);
    await fs.access(bridge);
  } catch {
    return {ok: false, reason: 'tree-sitter-runtime-unavailable'};
  }

  abortIfRequested(exec);
  let child;
  let timer;
  let failureReason = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout = [];
  const stderr = [];
  const onAbort = () => {
    failureReason ||= 'cancelled';
    child?.kill('SIGKILL');
  };
  try {
    child = spawn(settings.python, [bridge], {
      windowsHide: true,
      signal: exec.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    exec.signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => {
      failureReason ||= 'timeout';
      child.kill('SIGKILL');
    }, BRIDGE_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      const remaining = MAX_BRIDGE_STDOUT_BYTES - stdoutBytes;
      if (remaining <= 0 || chunk.length > remaining) {
        failureReason ||= 'stdout-limit';
        child.kill('SIGKILL');
      }
      if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
      stdoutBytes += Math.min(chunk.length, Math.max(0, remaining));
    });
    child.stderr.on('data', chunk => {
      const remaining = MAX_BRIDGE_STDERR_BYTES - stderrBytes;
      if (remaining <= 0 || chunk.length > remaining) {
        failureReason ||= 'stderr-limit';
        child.kill('SIGKILL');
      }
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, Math.max(0, remaining));
    });
    child.stdin.on('error', () => {
      failureReason ||= 'stdin-error';
    });
    child.stdin.end(JSON.stringify({source, members: names}), 'utf8');
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
    });
    if (exec.signal?.aborted) exec.signal.throwIfAborted();
    const stderrText = Buffer.concat(stderr).toString('utf8');
    if (failureReason) {
      return {ok: false, reason: `tree-sitter-${failureReason}`, detail: stderrText.slice(0, 500)};
    }
    if (exit.code !== 0) {
      return {
        ok: false,
        reason: 'tree-sitter-bridge-failed',
        exitCode: exit.code,
        exitSignal: exit.signal,
        detail: stderrText.slice(0, 500),
      };
    }
    const receipt = parseReceipt(Buffer.concat(stdout).toString('utf8'));
    if (!receipt) {
      return {ok: false, reason: 'tree-sitter-output-invalid', detail: stderrText.slice(0, 500)};
    }
    if (receipt.ok !== true) return {ok: false, reason: receipt.reason || 'tree-sitter-parse-failed'};
    if (!includeBytePositions) {
      for (const result of receipt.results || []) {
        for (const match of result.matches || []) {
          delete match.startByte;
          delete match.endByte;
          delete match.textBytes;
        }
      }
    }
    return {ok: true, receipt};
  } catch (error) {
    if (exec.signal?.aborted) throw error;
    return {
      ok: false,
      reason: failureReason ? `tree-sitter-${failureReason}` : 'tree-sitter-spawn-failed',
      detail: String(error.message || error).slice(0, 500),
    };
  } finally {
    if (timer) clearTimeout(timer);
    exec.signal?.removeEventListener('abort', onAbort);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function exactMatchRecord({
  name,
  match,
  lines,
  offset,
  limit,
  lineTextLimit,
  retrieveArguments,
}) {
  const start = offset ?? match.lineStart;
  if (start < match.lineStart || start > match.lineEnd) {
    return {
      member: name,
      memberState: 'range-outside-member',
      kind: match.kind,
      qualifiedSymbol: match.qualifiedSymbol,
      lineStart: match.lineStart,
      lineEnd: match.lineEnd,
      matches: [{
        ...match,
        lines: [],
        complete: false,
        rangeComplete: false,
        rangeOutsideMember: true,
      }],
      requestedRange: {offset: start, limit},
      contentLimitation: 'offset-outside-member-range',
      retrieveCurrent: {
        tool: 'project_evidence',
        arguments: perMemberArguments(retrieveArguments, name),
      },
    };
  }

  const end = Math.min(match.lineEnd, start + limit - 1);
  const rows = lineRows(lines, start, end, lineTextLimit);
  const truncation = truncationDetails(lines, start, end, lineTextLimit);
  const rowRangeComplete = start === match.lineStart
    ? end === Math.min(match.lineEnd, match.lineStart + limit - 1)
    : end === Math.min(match.lineEnd, start + limit - 1);
  const rangeComplete = rowRangeComplete && !truncation.lineTextTruncated;
  const memberComplete = start === match.lineStart
    && end === match.lineEnd
    && !truncation.lineTextTruncated;
  const hasMore = end < match.lineEnd;
  const canIncreaseText = truncation.nextLineTextLimit !== undefined;
  const lineTextMaximumReached = truncation.lineTextTruncated && !canIncreaseText;
  const contentLimitation = limitationFor({
    hasMore,
    lineTextTruncated: truncation.lineTextTruncated,
    canIncreaseText,
    prefixOmitted: start > match.lineStart,
  });
  const currentArguments = {
    ...perMemberArguments(retrieveArguments, name),
    offset: start,
    limit,
    lineTextLimit,
  };
  const next = lineTextMaximumReached
    ? null
    : canIncreaseText
      ? {lineTextLimit: truncation.nextLineTextLimit}
      : hasMore
        ? {offset: end + 1}
        : null;
  return {
    member: name,
    memberState: 'observed',
    kind: match.kind,
    qualifiedSymbol: match.qualifiedSymbol,
    lineStart: match.lineStart,
    lineEnd: match.lineEnd,
    matches: [{
      ...match,
      line: match.lineStart,
      lines: rows,
      complete: memberComplete,
      rangeComplete,
      rowRangeComplete,
      lineTextComplete: !truncation.lineTextTruncated,
      lineTextTruncated: truncation.lineTextTruncated,
      ...(truncation.maxLineLength ? {maxLineLength: truncation.maxLineLength} : {}),
      ...(hasMore ? {hasMore: true} : {hasMore: false}),
      ...(hasMore && !truncation.lineTextTruncated ? {nextOffset: end + 1} : {}),
      ...(lineTextMaximumReached ? {lineTextMaximumReached: true} : {}),
    }],
    requestedRange: {offset: start, limit, lineTextLimit},
    ...(lineTextMaximumReached ? {lineTextMaximumReached: true} : {}),
    ...(contentLimitation ? {contentLimitation} : {}),
    ...(next ? {
      nextRetrieval: {
        tool: 'project_evidence',
        arguments: {...currentArguments, ...next},
      },
    } : {}),
    retrieveCurrent: {tool: 'project_evidence', arguments: currentArguments},
  };
}

function ambiguousRecord(name, matches) {
  return {
    member: name,
    memberState: 'ambiguous',
    matches: matches.map(match => ({
      name: match.name,
      qualifiedSymbol: match.qualifiedSymbol,
      kind: match.kind,
      line: match.lineStart,
      lineStart: match.lineStart,
      lineEnd: match.lineEnd,
      startColumn: match.startColumn,
      endColumn: match.endColumn,
      complete: false,
      rangeComplete: false,
    })),
    contentLimitation: 'member-name-ambiguous',
    nextFactNeeded: 'Disambiguate the overload by passing offset within one candidate range, or inspect fastedit_java candidate metadata first; no overload was selected.',
  };
}

function missingRecord(name, reason = 'not-found-in-parsed-source') {
  return {
    member: name,
    memberState: reason,
    matches: [],
    contentLimitation: 'member-not-found',
  };
}

function maskJava(text) {
  return text.replace(
    /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"""[\s\S]*?(?:"""|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    match => match.replace(/[^\r\n]/g, ' '),
  );
}

function textWindowRecord({
  name,
  lines,
  offset,
  limit,
  lineTextLimit,
  retrieveArguments,
  fallbackReason,
  scanComplete,
  maskComments,
}) {
  const identifier = name.split('.').at(-1);
  const code = maskComments
    ? maskJava(lines.join('\n')).split('\n')
    : lines;
  const escaped = literal(identifier);
  const boundary = new RegExp('(^|[^\\w$])' + escaped + '([^\\w$]|$)');
  const matches = [];
  let lastEnd = -1;
  for (let index = 0; index < code.length && matches.length < MAX_FALLBACK_WINDOWS; index++) {
    if (index <= lastEnd || !boundary.test(code[index])) continue;
    const start = Math.max(1, index + 1 - FALLBACK_CONTEXT_LINES);
    const end = Math.min(lines.length, index + 1 + FALLBACK_CONTEXT_LINES, start + limit - 1);
    lastEnd = end - 1;
    const rows = lineRows(lines, start, end, lineTextLimit);
    const truncation = truncationDetails(lines, start, end, lineTextLimit);
    matches.push({
      line: index + 1,
      lines: rows,
      kind: 'text-window',
      complete: false,
      rangeComplete: false,
      rowRangeComplete: !truncation.lineTextTruncated,
      lineTextComplete: !truncation.lineTextTruncated,
      lineTextTruncated: truncation.lineTextTruncated,
      fallbackReason,
      ...(truncation.lineTextTruncated ? {maxLineLength: truncation.maxLineLength} : {}),
      ...(truncation.nextLineTextLimit ? {nextLineTextLimit: truncation.nextLineTextLimit} : {}),
    });
  }
  const memberState = matches.length
    ? 'observed-text-window'
    : scanComplete
      ? 'not-found-in-text-window'
      : 'not-found-before-scan-limit';
  const currentArguments = {
    ...perMemberArguments(retrieveArguments, name),
    offset,
    limit,
    lineTextLimit,
  };
  const nextLineTextLimit = Math.max(0, ...matches.map(match => match.nextLineTextLimit || 0));
  const lineTextMaximumReached = matches.some(match =>
    match.lineTextTruncated && !match.nextLineTextLimit);
  return {
    member: name,
    memberState,
    matches,
    requestedRange: {offset, limit, lineTextLimit},
    offsetApplied: false,
    ...(lineTextMaximumReached ? {lineTextMaximumReached: true} : {}),
    contentLimitation: 'text-window-not-syntax-complete',
    fallbackReason,
    ...(nextLineTextLimit ? {nextRetrieval: {
      tool: 'project_evidence',
      arguments: {...currentArguments, lineTextLimit: nextLineTextLimit},
    }} : {}),
    retrieveCurrent: {tool: 'project_evidence', arguments: currentArguments},
  };
}

function lexicalJavaRecord({
  name,
  lines,
  limit,
  lineTextLimit,
  retrieveArguments,
  fallbackReason,
  scanComplete,
}) {
  const identifier = name.split('.').at(-1);
  const escaped = literal(identifier);
  const code = maskJava(lines.join('\n')).split('\n');
  const declaration = new RegExp(
    '^\\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\\s+)*'
    + '(?:[\\w$<>\\[\\].?,]+\\s+)*' + escaped + '\\s*\\(',
  );
  const field = new RegExp(
    '^\\s*(?:(?:public|protected|private|static|final|transient|volatile)\\s+)*'
    + '(?:[\\w$<>\\[\\].?,]+\\s+)+' + escaped + '\\s*(?:=|;)',
  );
  const matches = [];
  for (let index = 0; index < code.length && matches.length < MAX_FALLBACK_WINDOWS; index++) {
    const method = declaration.test(code[index])
      && !/^\s*(?:if|else|while|for|switch|return|throw|new)\b/.test(code[index]);
    const isField = field.test(code[index]);
    if (!method && !isField) continue;
    let depth = 0;
    let opened = false;
    let complete = false;
    let scanEnd = index;
    for (let cursor = index; cursor < code.length && cursor < index + MAX_MEMBER_LINES; cursor++) {
      scanEnd = cursor;
      const current = code[cursor];
      if (method) {
        for (const character of current) {
          if (character === '{') {
            depth++;
            opened = true;
          } else if (character === '}') {
            depth--;
          }
        }
        if (opened && depth === 0) {
          complete = true;
          break;
        }
        if (!opened && current.includes(';')) break;
      } else {
        for (const character of current) {
          if ('({['.includes(character)) depth++;
          else if (')}]'.includes(character)) depth--;
        }
        if (depth === 0 && current.trimEnd().endsWith(';')) {
          complete = true;
          break;
        }
      }
    }
    if (method && !opened) continue;
    const lineStart = index + 1;
    const availableEnd = scanEnd + 1;
    const lineEnd = Math.min(availableEnd, lineStart + limit - 1);
    const rows = lineRows(lines, lineStart, lineEnd, lineTextLimit);
    const truncation = truncationDetails(lines, lineStart, lineEnd, lineTextLimit);
    const rowRangeComplete = lineEnd === Math.min(availableEnd, lineStart + limit - 1);
    const scanCapped = !complete
      && code.length > index + MAX_MEMBER_LINES
      && scanEnd === index + MAX_MEMBER_LINES - 1;
    const hasMore = lineEnd < availableEnd || scanCapped;
    const lineTextMaximumReached = truncation.lineTextTruncated
      && truncation.nextLineTextLimit === undefined;
    matches.push({
      line: lineStart,
      lineStart,
      lineEnd: availableEnd,
      lines: rows,
      kind: method ? 'lexical-brace-member' : 'lexical-field-declaration',
      complete: false,
      lexicalRangeComplete: complete,
      rangeComplete: rowRangeComplete && !truncation.lineTextTruncated,
      rowRangeComplete,
      lineTextComplete: !truncation.lineTextTruncated,
      lineTextTruncated: truncation.lineTextTruncated,
      ...(truncation.lineTextTruncated ? {maxLineLength: truncation.maxLineLength} : {}),
      ...(hasMore ? {hasMore: true} : {hasMore: false}),
      ...(hasMore && !truncation.lineTextTruncated ? {nextOffset: lineEnd + 1} : {}),
      ...(lineTextMaximumReached ? {lineTextMaximumReached: true} : {}),
      ...(!complete && !hasMore ? {unterminatedWithinSource: true} : {}),
    });
  }

  if (!matches.length) {
    return textWindowRecord({
      name,
      lines,
      offset: 1,
      limit,
      lineTextLimit,
      retrieveArguments,
      fallbackReason,
      scanComplete,
      maskComments: true,
    });
  }

  const currentArguments = {
    ...perMemberArguments(retrieveArguments, name),
    limit,
    lineTextLimit,
  };
  const nextMatch = matches.find(match => match.hasMore || match.lineTextTruncated);
  const nextLineTextLimit = Math.max(0, ...matches.map(match => {
    const selected = lines.slice(match.lineStart - 1, match.lineEnd);
    return Math.max(0, ...selected.map(line => line.length));
  }));
  const canIncreaseText = nextLineTextLimit > lineTextLimit && nextLineTextLimit <= MAX_LINE_TEXT_LIMIT;
  const lineTextMaximumReached = matches.some(match => match.lineTextMaximumReached);
  const next = lineTextMaximumReached
    ? null
    : canIncreaseText
      ? {...currentArguments,lineTextLimit: nextLineTextLimit}
      : nextMatch?.hasMore
        ? {...currentArguments,offset: nextMatch.nextOffset}
        : null;
  return {
    member: name,
    memberState: matches.length === 1 ? 'observed-lexical' : 'ambiguous-lexical',
    matches,
    requestedRange: {limit, lineTextLimit},
    ...(lineTextMaximumReached ? {lineTextMaximumReached: true} : {}),
    contentLimitation: matches.some(match => match.lineTextTruncated && nextLineTextLimit > MAX_LINE_TEXT_LIMIT)
      ? 'lexical-range-not-ast-verified-and-line-text-exceeds-maximum'
      : 'lexical-range-not-ast-verified',
    fallbackReason,
    ...(next ? {
      nextRetrieval: {tool: 'project_evidence', arguments: next},
    } : {}),
    retrieveCurrent: {tool: 'project_evidence', arguments: currentArguments},
  };
}

function sourceRetrieval(args, requested) {
  return {
    ...(args.query ? {query: args.query} : {}),
    ...(requested.plural ? {members: requested.names} : {member: requested.names[0]}),
  };
}

export async function sourceMemberSource({
  filePath,
  displayPath,
  lines,
  sourceText,
  totalLines,
  args,
  exec,
  options = {},
  scanComplete = true,
  scanLimitation = null,
  nativeTextTruncated = false,
  extra = {},
}) {
  abortIfRequested(exec);
  const requested = requestedMembers(args);
  const limit = checkedMemberLimit(args.limit);
  const lineTextLimit = checkedLineTextLimit(args.lineTextLimit);
  const parseSource = sourceText ?? lines.join('\n');
  const retrieveBase = {
    mode: 'source',
    ...sourceRetrieval(args, requested),
  };
  const base = {
    state: 'observed',
    path: displayPath,
    totalLines: Number.isInteger(totalLines) ? totalLines : lines.length,
    scannedLines: lines.length,
    scanComplete,
    ...(scanLimitation ? {scanLimitation} : {}),
    ...(nativeTextTruncated ? {nativeLineTextTruncated: true} : {}),
    lineTextLimit,
    ...extra,
  };

  const isJava = /\.java$/i.test(filePath);
  const settings = parserSettings(options);
  const hasOriginalSourceText = typeof sourceText === 'string';
  let parsed = null;
  let fallbackReason = null;
  if (isJava && settings.memberParsing && scanComplete && !nativeTextTruncated) {
    parsed = await parseJavaMembers(parseSource, requested.names, exec, options, hasOriginalSourceText);
    if (
      parsed.ok
      && (
        !Array.isArray(parsed.receipt.results)
        || parsed.receipt.results.length !== requested.names.length
        || parsed.receipt.results.some(result =>
          !result
          || !Number.isInteger(result.total)
          || !Array.isArray(result.matches))
      )
    ) {
      parsed = {ok: false, reason: 'tree-sitter-receipt-invalid'};
    }
    if (!parsed.ok) fallbackReason = parsed.reason;
  } else if (isJava) {
    fallbackReason = nativeTextTruncated
      ? 'native-line-text-truncated'
      : !scanComplete
        ? 'source-scan-incomplete'
        : 'member-parsing-disabled';
  } else {
    fallbackReason = 'language-not-java';
  }

  let records;
  if (parsed?.ok) {
    records = parsed.receipt.results.map((result, index) => {
      const name = requested.names[index];
      if (result.total === 0) return missingRecord(name);
      const lineSelected = Number.isInteger(args.offset)
        ? result.matches.filter(match => args.offset >= match.lineStart && args.offset <= match.lineEnd)
        : [];
      if (result.total > 1 && lineSelected.length !== 1) return ambiguousRecord(name, result.matches);
      return exactMatchRecord({
        name,
        match: lineSelected[0] || result.matches[0],
        lines,
        offset: args.offset,
        limit,
        lineTextLimit,
        retrieveArguments: retrieveBase,
      });
    });
    base.parser = {
      language: 'java',
      mode: 'tree-sitter',
      engine: parsed.receipt.parser,
      parseComplete: true,
      positionBasis: hasOriginalSourceText ? 'original-text-line-column-byte' : 'normalized-text-line-column',
      availableMembersTruncated: parsed.receipt.availableTruncated === true,
    };
  } else if (isJava) {
    records = requested.names.map(name => lexicalJavaRecord({
      name,
      lines,
      limit,
      lineTextLimit,
      retrieveArguments: retrieveBase,
      fallbackReason,
      scanComplete,
    }));
    base.parser = {
      language: 'java',
      mode: 'lexical',
      parseComplete: false,
      fallbackReason,
    };
    base.contentLimitation = 'lexical-range-not-ast-verified';
  } else {
    records = requested.names.map(name => textWindowRecord({
      name,
      lines,
      offset: args.offset ?? 1,
      limit,
      lineTextLimit,
      retrieveArguments: retrieveBase,
      fallbackReason,
      scanComplete,
      maskComments: false,
    }));
    base.parser = {
      language: path.extname(filePath).slice(1) || 'unsupported',
      mode: 'text-window',
      parseComplete: false,
      fallbackReason,
    };
    base.contentLimitation = 'text-window-not-syntax-complete';
  }

  const limitations = [...new Set(records.map(record => record.contentLimitation).filter(Boolean))];
  if (limitations.length) base.contentLimitations = limitations;
  if (requested.plural) {
    return {
      ...base,
      members: records,
      retrieveCurrent: {tool: 'project_evidence', arguments: retrieveBase},
      note: 'Members remain an array for an array request. Each match.complete covers only that declaration; parsed range completeness is separate from related callers, constants, and runtime behavior.',
    };
  }
  return {
    ...base,
    ...records[0],
    retrieveCurrent: records[0].retrieveCurrent
      || {tool: 'project_evidence', arguments: retrieveBase},
    note: 'A single member request returns a flat record. match.complete covers only that declaration; it does not establish related callers, constants, or runtime behavior.',
  };
}

function unavailableRecords(args, reason, code) {
  const requested = requestedMembers(args);
  const record = name => ({
    member: name,
    memberState: reason,
    matches: [],
    rangeComplete: false,
    lineTextComplete: false,
    contentLimitation: code,
    nextFactNeeded: 'No member body was delivered; obtain the selected source through the authorized read path before drawing source-level conclusions.',
  });
  return requested.plural
    ? {members: requested.names.map(record)}
    : record(requested.names[0]);
}

function fileIdentity(value) {
  const result = {};
  for (const key of ['version', 'revision', 'bytes', 'size', 'lineCount', 'mtime', 'mtimeMs', 'modifiedAt']) {
    if (value?.[key] !== undefined && value[key] !== null) result[key] = value[key];
  }
  return result;
}

async function workspaceStat(file, exec, call) {
  const result = await call('work-evidence:stat', {path: file}, exec);
  abortIfRequested(exec);
  const value = wrapped(result.value);
  if (
    result.isError
    || value?.status === 'error'
    || value?.status === 'rejected'
    || !value
    || typeof value.exists !== 'boolean'
  ) {
    return {
      ok: false,
      state: 'unavailable',
      code: errorCode(result, 'WORKSPACE_STAT_UNAVAILABLE'),
      message: textOf(result).slice(0, 1000),
    };
  }
  if (!value.exists) return {ok: false, state: 'unavailable', code: 'SOURCE_NOT_FOUND'};
  return {ok: true, value};
}

async function readWorkspaceSnapshot(file, exec, call) {
  const initialStat = await workspaceStat(file, exec, call);
  if (!initialStat.ok) return initialStat;
  const statValue = initialStat.value;
  const initialIdentity = fileIdentity(statValue);
  if (!Object.keys(initialIdentity).length) {
    return {ok: false, state: 'unknown', code: 'SOURCE_IDENTITY_UNAVAILABLE'};
  }

  const expectedLines = Number.isInteger(statValue.lineCount) ? statValue.lineCount : null;
  const expectedBytes = Number.isInteger(statValue.bytes) ? statValue.bytes : null;
  let offset = 1;
  let chars = 0;
  const collected = [];
  let nativeTruncated = false;
  let nativeLineTextTruncated = false;
  let lastTotal = expectedLines;
  while (offset <= (lastTotal ?? Number.MAX_SAFE_INTEGER)) {
    if (collected.length >= MAX_SOURCE_LINES || chars >= MAX_SOURCE_BYTES) break;
    const result = await call('read', {
      file_path: file,
      offset,
      limit: READ_PAGE_LINES,
    }, exec);
    abortIfRequested(exec);
    const value = wrapped(result.value);
    if (result.isError || !Array.isArray(value?.lines)) {
      return {
        ok: false,
        state: 'unavailable',
        code: errorCode(result, 'SOURCE_READ_UNAVAILABLE'),
        message: textOf(result).slice(0, 1000),
      };
    }
    if (!value.lines.length) break;
    for (const item of value.lines) {
      const line = Number.isInteger(item?.number) ? item.number : Number(item?.line);
      const text = String(item?.text ?? '');
      if (!Number.isInteger(line) || line < 1) {
        return {ok: false, state: 'unknown', code: 'UNRECOGNIZED_READ_LINE'};
      }
      collected.push({number: line, text});
      chars += text.length + 1;
      nativeLineTextTruncated ||= item?.truncated === true
        || item?.lineTextTruncated === true
        || /\.\.\. \(line truncated to \d+ chars\)$/.test(text);
    }
    nativeTruncated ||= value.truncatedByBytes === true;
    lastTotal = Number.isInteger(value.totalLines) ? value.totalLines : lastTotal;
    const nextOffset = value.lines.at(-1).number + 1;
    if (nextOffset <= offset) return {ok: false, state: 'unknown', code: 'READ_PAGE_DID_NOT_ADVANCE'};
    offset = nextOffset;
  }

  const finalStat = await workspaceStat(file, exec, call);
  if (!finalStat.ok) return finalStat;
  const currentIdentity = fileIdentity(finalStat.value);
  const changedFields = Object.keys(initialIdentity).filter(key =>
    currentIdentity[key] === undefined || currentIdentity[key] !== initialIdentity[key]);
  if (changedFields.length) {
    return {
      ok: false,
      state: 'unavailable',
      code: 'SOURCE_CHANGED',
      changedFields,
      message: 'Source identity changed while paged reads were assembled; no member range was parsed or delivered.',
    };
  }

  collected.sort((a, b) => a.number - b.number);
  const totalLines = lastTotal ?? collected.at(-1)?.number ?? 0;
  nativeTruncated ||= nativeLineTextTruncated;
  const contiguous = collected.every((item, index) => item.number === index + 1);
  const scanComplete = !nativeTruncated
    && collected.length <= MAX_SOURCE_LINES
    && chars <= MAX_SOURCE_BYTES
    && (expectedBytes === null || expectedBytes <= MAX_SOURCE_BYTES)
    && collected.length === totalLines
    && contiguous;
  return {
    ok: true,
    state: scanComplete ? 'observed' : 'partial',
    lines: collected.map(item => item.text),
    totalLines,
    scanComplete,
    nativeLineTextTruncated,
    revision: typeof initialIdentity.revision === 'string' ? initialIdentity.revision : null,
    scanLimitation: scanComplete
      ? null
      : nativeLineTextTruncated
        ? 'native-line-text-truncated'
        : nativeTruncated
          ? 'native-read-byte-truncated'
          : 'source-scan-budget-exceeded',
  };
}

export async function workspaceMemberSource(file, args, exec, call, options = {}) {
  const requested = requestedMembers(args);
  const snapshot = await readWorkspaceSnapshot(file, exec, call);
  if (!snapshot.ok) {
    return {
      state: snapshot.state || 'unknown',
      path: file,
      code: snapshot.code,
      ...(snapshot.message ? {message: snapshot.message} : {}),
      ...unavailableRecords(args, 'read-unavailable', snapshot.code),
    };
  }
  const result = await sourceMemberSource({
    filePath: file,
    displayPath: file,
    lines: snapshot.lines,
    totalLines: snapshot.totalLines,
    args: {...args, members: requested.plural ? args.members : undefined},
    exec,
    options,
    scanComplete: snapshot.scanComplete,
    scanLimitation: snapshot.scanLimitation,
    nativeTextTruncated: snapshot.nativeLineTextTruncated,
    extra: snapshot.revision ? {revision: snapshot.revision} : {},
  });
  return result;
}
