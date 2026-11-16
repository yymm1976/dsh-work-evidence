/**
 * Classifies a user request as read-only: no affirmative write request survives its own
 * clause's denial. Exported so the whole denial invariant can be tested directly instead
 * of only through a host prompt, which is what let successive clause bugs through.
 *
 * The module is written as named pieces rather than one dense `some()` so each invariant
 * below is visible and separately testable. Invariants (each has a bidirectional case in
 * test/task-intent.test.mjs):
 *
 * 1. A denial governs only its own clause. Sentence ends (`.`, `!`, `?`, `。`, `！`, `？`,
 *    `；`, `;`, newline) and commas split clauses. A segment that starts with a list
 *    conjunction, or whose predecessor named a verb but no target, stays with that
 *    predecessor so "do not modify, create, or delete a.js" stays one denied clause.
 * 2. An allowance must follow the denial in the same clause and must itself be a write
 *    clause. A repeated denial is not permission.
 * 3. A modal denial's own word ("must" in "must not") is not an allowance.
 * 4. A denial that only introduces an idiom ("don't forget to", "do not hesitate to")
 *    does not deny the verb it introduces.
 * 5. A write before the denial in the same clause still counts.
 * 6. An English noun that looks like a verb ("the patch", "the update") is not a request.
 * 7. A denial word inside a path ("src/never.js", "src/can-edit.js") is not a denial and
 *    not an allowance.
 * 8. Every candidate verb inside a matched span is examined, not only the first.
 */

// Verbs that name a change to a file. The Chinese set and the English set are kept
// together so the initial gate, clause evaluation and allowance detection agree.
const VERB_ZH='修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改';
const VERB_EN='modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch';
// The same verbs in the form the request patterns use. Chinese 改 must not match 改动/改变,
// which are descriptions ("no change in behaviour") rather than requests.
const VERB_ZH_REQUEST='修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改(?!动|变)';

const DENIAL_ZH='不得|不要|不能|不可|无需|不必|不准|禁止|不允许|不应|请勿|勿';
const DENIAL_EN="do not|don't|never|must not|mustn't|may not|mayn't|should not|shouldn't|shall not|shan't|cannot|can't|won't|wouldn't|would not|will not|need not|needn't";

// A target is a path-like word, an extensionless name (README), or one of the Chinese
// nouns that name a code artefact.
const TARGET='[\\w./\\\\-]+\\.[a-z0-9]{1,8}\\b|[\\w-]*\\/[\\w.-]+|文件|代码|函数|方法|类|模块|程序|脚本|实现|逻辑|配置|file|code|function|method|class|module|program|script|config';
// Sentence and clause boundaries. A period splits only before a capital so "src/a.js"
// and "v1.2" stay intact; `!` and `?` need no such guard, but a following lowercase letter
// would mean an abbreviation rather than a new sentence.
const CLAUSE_BOUNDARY=/[。！？；;\n，,]|[.!?](?=\s+[A-Z])/u;
// A path-like token. Denial words are removed from these before any matching, so
// "src/never.js" and "src/can-edit.js" cannot act as denial or allowance.
const PATH_TOKEN=/(?:[\w.\\/-]*[\\/][\w.\\\\/-]+|[\w-]+\.[a-z0-9]{1,8}\b)/giu;

const writeVerb=new RegExp(`(?:${VERB_ZH}|${VERB_EN})`,'iu');
const denialOnly=new RegExp(`(?:${DENIAL_ZH}|${DENIAL_EN})`,'iu');
const readOnlyMarker=/(?:只读|read[- ]only)/iu;
const englishVerb=new RegExp(VERB_EN,'iu');

const writeRequestPatterns=()=>{
  // A verb must be followed by a target inside the same sentence. The leading class
  // anchors the verb to a word boundary so "edits" as a noun stays a description.
  const lead='(?:^|[，,、：:\\s	])';
  const gap='[^。！？；;\\n]{0,16}';
  const main=new RegExp(`${lead}(?:[^。！？；;\\n]{0,8})?(?:(?:${VERB_ZH_REQUEST})|(?:${VERB_EN})\\b)${gap}(?:${TARGET})`,'iu');
  // The ALL-CAPS variant needs a case-sensitive pattern: under /iu a plain `create`
  // would also match sentence-initial "Create README", but [A-Z] would also match
  // lowercase "edits". English verbs are spelled as letter classes for that reason.
  const capsVerb='[Mm]odify\\b|[Ff]ix\\b|[Ii]mplement\\b|[Ww]rite\\b|[Ee]dit\\b|[Cc]reate\\b|[Dd]elete\\b|[Rr]eplace\\b|[Uu]pdate\\b|[Aa]dd\\b|[Cc]hange\\b|[Rr]efactor\\b|[Rr]emove\\b|[Rr]ename\\b|[Pp]atch\\b';
  const caps=new RegExp(`${lead}(?:[^。！？；;\\n]{0,8})?(?:(?:${VERB_ZH_REQUEST})|${capsVerb})${gap}[A-Z][A-Z0-9_-]{1,30}\\b`,'u');
  return [main,caps];
};

const nounPrefix=/(?:^|\s)(?:a|an|the|this|that|these|those|its|their|his|her|our|your|my|any|some|each|every|no)\s+$/iu;

/** Remove path-like tokens so a filename cannot be read as a denial or an allowance. */
export function stripPaths(text){
  return String(text??'').replace(PATH_TOKEN,(token)=>' '.repeat(token.length));
}

/**
 * Does `text` contain an affirmative write request? Every verb candidate inside every
 * match is examined: a single match can span a noun use and a real request, and stopping
 * at the first candidate would miss the second one.
 */
function hasWriteRequest(text,patterns=writeRequestPatterns()){
  for(const pattern of patterns){
    for(const match of text.matchAll(new RegExp(pattern.source,`${pattern.flags.replace('g','')}g`))){
      // Locate each verb inside the match; the pattern may start at a determiner, which
      // would otherwise hide the noun use.
      for(const verb of match[0].matchAll(new RegExp(`(?:${VERB_ZH_REQUEST})|(?:${VERB_EN})`,'giu'))){
        const verbAt=match.index+verb.index;
        if(!nounPrefix.test(text.slice(Math.max(0,verbAt-24),verbAt)))return true;
      }
    }
  }
  return false;
}

/** Split a request into clauses, keeping verb lists under one denial together. */
export function taskClauses(request){
  const clauses=[];
  for(const raw of String(request??'').split(CLAUSE_BOUNDARY)){
    const previous=clauses.at(-1);
    const continues=/^\s*(?:or\b|nor\b|and\b|以及|或者|或是|或|和)/iu.test(raw)&&previous!==undefined;
    const incomplete=previous!==undefined&&writeVerb.test(previous)&&!hasWriteRequest(previous);
    if(continues||incomplete)clauses[clauses.length-1]+=raw;
    else clauses.push(raw);
  }
  return clauses;
}

export function isReadOnlyTaskRequest(request){
  if(!readOnlyMarker.test(request)&&
    !new RegExp(`(?:${DENIAL_ZH}|${DENIAL_EN}).{0,24}(?:${VERB_ZH}|${VERB_EN})`,'iu').test(stripPaths(request)))return false;
  const patterns=writeRequestPatterns();
  return !taskClauses(request).some(clause=>{
    // Denials and allowances are read from the text with paths removed, so a filename
    // such as src/never.js or src/can-edit.js cannot decide the clause either way.
    const prose=stripPaths(clause);
    if(!writeVerb.test(prose))return false;
    if(!hasWriteRequest(clause,patterns))return false;
    const denialAt=prose.search(denialOnly);
    if(denialAt<0)return true;
    // The text before the first denial is not governed by it: "Fix a.js, do not modify
    // b.js" asks for the first edit and forbids only the second.
    const prefix=clause.slice(0,denialAt);
    // A denial that only introduces an idiom does not deny the verb it introduces.
    if(/^\s*(?:forget|hesitate|fail|neglect)\b|^\s*(?:忘记|忘了|犹豫)/iu.test(prose.slice(denialAt).replace(denialOnly,'')))return true;
    if(writeVerb.test(prefix)&&hasWriteRequest(prefix,patterns))return true;
    const denial=denialOnly.exec(prose.slice(denialAt));
    if(!denial)return true;
    // The allowance must follow the denial and must itself be a write clause. Searching
    // from the denial's start would read the "must" of "must not" as an allowance.
    const remaining=prose.slice(denialAt+denial[0].length);
    const allowanceAt=remaining.search(allowedAfterDenial());
    if(allowanceAt<0)return false;
    return !denialOnly.test(remaining.slice(allowanceAt));
  });
}

// An allowance word must be its own token: in "src/can-edit.js" the `can` is part of a
// filename. Paths are stripped before this runs, and the trailing class keeps the word
// from being a prefix of a longer one.
function allowedAfterDenial(){
  return new RegExp(`(?:^|[^A-Za-z0-9_-])(?:但|但是|不过|然而|而是|需要|允许|可以|请|必须|应当|instead|however|but|should|must|can|may)(?![A-Za-z0-9_-]).{0,40}(?:(?:${VERB_ZH_REQUEST})|(?:${VERB_EN})\\b)`,'iu');
}
