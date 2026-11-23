/**
 * Classifies a user request as read-only.
 *
 * The only consumer is `surfaceModeForRequest`: a read-only verdict hides `work_exec` and
 * `verified_exec`. The error is asymmetric — hiding edit tools from a writable task can
 * lose the task, while exposing them on a read-only task changes nothing (native
 * permissions still apply). So the classifier answers "can I prove an affirmative write
 * request?" and says writable only when it can.
 *
 * Design (see runs/v251/TASK-INTENT-STATE-MACHINE.md): for every write verb candidate,
 * look ONLY at the text before it inside its sentence.
 *   - no preceding denial            -> affirmative
 *   - a preceding denial, but an idiom ("don't forget to") sits between -> affirmative
 *   - a preceding denial, and an allowance marker sits between          -> affirmative
 *   - otherwise                       -> denied
 * A sentence with at least one affirmative candidate is writable evidence. Read-only is
 * returned only when the text denies every write verb in every sentence.
 *
 * There is deliberately no "what comes after the denial" scan: that suffix-slicing is
 * what let a denial swallow a later clause, a comma list lose its denial, the `must` of
 * "must not" act as an allowance, and a noun phrase read as a request. Looking backwards
 * from each verb removes all four at once.
 *
 * Lexical guards use only local context around the candidate:
 *   1. a verb preceded by a determiner is a noun ("the patch", "the update");
 *   2. English words match whole words only ("whenever", "bugfix", "prefix");
 *   3. a read verb followed by a name and a code noun identifies the symbol ("explain add method").
 */

const VERB_ZH='修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改';
// 重写 (rewrite) is in the Chinese list, so `rewrite` must be in the English one: the clause
// scan and the target-free implementation route have to agree about what a verb is, or
// "Do not modify README.md. Rewrite the parser." passes the implementation gate and then
// finds no verb to judge in the clause scan.
const VERB_EN='modify|fix|implement|write|rewrite|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch';
// 不可 is deliberately absent: it is far more often part of an adjective (不可用, 不可靠,
// 不可避免) than a denial, and including it classified "执行程序并保留真实不可用结果" as
// read-only. 不能被/不可修改 are covered by 不能 plus the verb scan.
// 别 and 勿 are single characters, so they match inside compound words: 分别 (separately),
// 识别 (recognise), 区别, 特别, 类别. Measured: `分别修改 src/a.js 和 src/b.js。` was read-only
// because 别 inside 分别 was taken as a denial and 修改 as denied. They therefore require a
// character that cannot be part of a compound: start of text, punctuation, or a space.
// 不要/不必/不准 stay in the plain list because a two-character form is unambiguous.
// A bare 不 only qualifies when it directly negates a known write verb.
const DENIAL_ZH='不得|不要|不能|无需|不必|不用|不准|不需要|严禁|禁止|不允许|不应|请勿|(?<![分识区特类级告性鉴辨个])别|(?<![请])勿|莫|(?<![得能会])不(?=(?:'+VERB_ZH+'))';
const DENIAL_EN="do not|don't|never|must not|mustn't|may not|mayn't|should not|shouldn't|shall not|shan't|cannot|can't|won't|wouldn't|would not|will not|need not|needn't|not allowed to|not supposed to|make sure not to|be sure not to|no need to|there is no need to";
// A denial that only introduces an idiom does not deny the verb after it.
const IDIOM='forget|hesitate|fail|neglect|忘记|忘了|犹豫';
// A marker that turns a preceding denial into permission.
const ALLOWANCE='但|但是|不过|然而|而是|反而|只|仅|需要|允许|可以|请|必须|应当|instead|however|but|should|must|can|may|only';
// A target: a path-like word, an extensionless name, or a Chinese code noun.
// Test artifacts belong here too: "Add regression tests" is a write request whose object is
// the suite, and without these the denied first sentence of a two-clause task decides the
// whole request and hides the edit tools. Adding them to the ONE target definition (rather
// than to a second predicate) is what keeps the request test and the allowance test agreeing.
// The English nouns are wrapped in word boundaries. Without them `file` matches inside
// `files`, so `Do not modify any files.` counts as a request WITH a target — and that made a
// denied sentence set sawRequest, which then hid `work_exec` from an explicit
// "Use work_exec to run ..." request in the next sentence. The Chinese nouns need no
// boundary; they are already whole words.
const TARGET='[\\w./\\\\-]+\\.[a-z0-9]{1,8}|[\\w-]*\\/[\\w.-]+|文件|代码|函数|方法|类|模块|程序|脚本|实现|逻辑|配置|测试|用例|单测|回归|'+
  '(?<![A-Za-z0-9_])(?:file|files|code|function|method|class|module|program|script|config|test|tests|spec|specs|suite|fixture|anything|everything)(?![A-Za-z0-9_])'+
  '|任何|一切';
// An ALL-CAPS identifier (README, MAKEFILE) is a target too. It is matched separately
// because a case-insensitive verb pattern cannot also be case-sensitive about its object.
const CAPS_TARGET=/[A-Z][A-Z0-9_-]{1,30}(?![A-Za-z0-9_])/u;

// English alternatives are wrapped in lookarounds instead of \b: the patterns are built
// with /u, and \b is defined on ASCII word characters, which already excludes CJK, but a
// plain `never` would still match inside `whenever` or `bugfix`.
const enWord=alternatives=>`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`;
const VERB_ANY=`(?:${VERB_ZH}|${enWord(VERB_EN)})`;
const DENIAL_ANY=`(?:${DENIAL_ZH}|${enWord(DENIAL_EN)})`;

const verbPattern=new RegExp(VERB_ANY,'giu');
const denialPattern=new RegExp(DENIAL_ANY,'giu');
// Non-global test patterns are separate objects: a global regex carries `lastIndex`
// between calls, so sharing one with matchAll would silently change what later calls see.
const verbProbe=new RegExp(VERB_ANY,'iu');
const denialProbe=new RegExp(DENIAL_ANY,'iu');
const idiomPattern=new RegExp(`(?:${enWord(IDIOM)})|(?:${IDIOM.split('|').filter(x=>/[\u4e00-\u9fff]/u.test(x)).join('|')})`,'iu');
const allowancePattern=new RegExp(`(?:^|[^A-Za-z0-9_-])(?:${ALLOWANCE})(?![A-Za-z0-9_-])`,'iu');
// A determiner directly before the verb makes it the object of that phrase.
const nounPrefix=/(?:^|\s)(?:a|an|the|this|that|these|those|its|their|his|her|our|your|my|any|some|each|every|no)\s+$/iu;
// Chinese has no determiner, but it does have a possessive/attributive particle that turns a
// verb into the head noun of a phrase: "这个模块的实现" is "this module's implementation", and
// 「实现」 there is a noun. Measured: `只读分析 src/a.js 的实现。` was classified writable
// because 实现 was read as a write verb, so the explicit 只读 marker never decided.
// The characters before the verb are what make it a noun: 的 / 此 / 该 / 这 / 那 / 本 / 其.
// Only the two constructions that unambiguously make a following verb a noun:
//   English determiner   "the patch", "the update"
//   Chinese 的/之        "这个模块的实现"
// The earlier list also had 此/该/这/那/本/其/各/每/某/所有/全部. Those are adverbs as often as
// they are attributives — 「请全部更新 src/a.js」 puts 全部 before a VERB — and a regex cannot
// tell the two apart. The error is asymmetric: reading a request as a noun drops the clause,
// the task becomes read-only, and the write tools are hidden. So the ambiguous set is dropped
// and only the certain set remains; 「全部的更新」 then reads as a verb, which is the harmless
// direction. This is the third round this file has been narrowed and widened here.
const CJK_NOUN_PREFIX=/(?:的|之)\s*$/u;
const READ_SYMBOL_PREFIX=/(?:解释|说明|查看|阅读|分析|检查|核对|追踪)\s*`?$|(?:^|\s)(?:explain|describe|inspect|read|review|summarize|trace)\s+`?$/iu;
const READ_SYMBOL_SUFFIX=/^`?\s*(?:函数|方法|属性|变量|接口|类|(?:function|method|property|variable|interface|class)(?![A-Za-z0-9_]))/iu;
const readOnlyMarker=/(?:只读|read[- ]only)/iu;
// Sentence boundaries. A period splits only before a capital so "src/a.js" survives.
// Sentence boundaries. A period splits only before a capital so "src/a.js" survives.
//
// A COMMA is also a boundary, because `Do not touch the config, update src/a.js.` is one
// clause forbidding one thing and requesting another. Leaving the comma inside the sentence
// let the denial govern `update` too, the task classified read-only, and the host really did
// strip work_exec from the tool schema — the most damaging defect an adversarial review found.
//
// But a comma is ALSO how a verb list continues: `do not modify, create, or delete src/a.js`
// must keep its denial on every verb. The two are distinguished by what follows the comma:
// a bare verb (or a conjunction then a verb) continues the list, while anything with its own
// object starts a new clause. `splitSentences` applies that rule; the regex alone cannot.
// Sentence boundaries. A period splits only before a capital so "src/a.js" survives, and it
// must NOT split when the dot introduces a path prefix: `Fix ./src/b.js` split into `Fix` and
// `/src/b.js`, so the verb lost its target and a denied earlier sentence decided the task.
const SENTENCE_BOUNDARY=/[。！？；;\n]|[.!?](?!\s*[a-z0-9])(?!\s*[\\/.])/u;
const COMMA=/[，,]/u;
/** Is the text after a comma a bare verb list continuation rather than a new clause? */
// A continuation is a SHORT verb sequence: `create,` / `or delete src/a.js` where the verb has
// no object before the next comma. `update src/a.js` carries its own object and is therefore a
// new clause even though it starts with a verb — that distinction is the whole rule, and
// testing only "starts with a verb" made `Do not touch the config, update src/a.js.` read-only
// again, which is the defect this split exists to fix.
function continuesVerbList(tail){
  const verb=new RegExp(`^\\s*(?:or|and|nor|或者|或|以及|和)?\\s*${VERB_ANY}`,'iu').exec(tail);
  if(!verb)return false;
  const conjunction=/^\s*(?:or|and|nor|或者|或|以及|和)\s*/iu.test(tail);
  const rest=tail.slice(verb[0].length);
  // An explicit conjunction makes it a coordinate list: `do not modify, create, or delete` and
  // `不要修改，或者创建` both keep the denial on every verb, whatever object each carries.
  if(conjunction)return true;
  // Without a conjunction the verb must be bare — followed by the next comma or another verb —
  // or it carries its own object and starts a new clause:
  // `Do not touch the config, update src/a.js.` is one denial and one request.
  return /^\s*[，,]/.test(rest)||new RegExp(`^\\s*(?:or|and|nor|或者|或|以及|和)?\\s*${VERB_ANY}`,'iu').test(rest);
}

/** Split into clauses, keeping a verb list inside one clause. */
export function splitSentences(text){
  const raw=String(text??'');
  const out=[];
  // First split on real boundaries; then split each piece on commas that start a new clause.
  //
  // A merged verb list is NOT the end of the scan. `Do not modify, create, or delete src/a.js,
  // fix src/b.js.` has two comma decisions: the first two merge into one denied list, and the
  // third starts a new clause. The earlier `break` stopped at the merge, so `fix src/b.js`
  // inherited the denial and the whole request classified read-only.
  for(const piece of raw.split(SENTENCE_BOUNDARY)){
    if(!piece.trim())continue;
    let current='';
    let rest=piece;
    for(;;){
      const match=COMMA.exec(rest);
      if(!match){current+=rest;break;}
      const head=rest.slice(0,match.index),tail=rest.slice(match.index+1);
      if(continuesVerbList(tail)){
        // Keep the list inside the clause and keep scanning the remainder.
        current+=head+'，';
        rest=tail;
        continue;
      }
      current+=head;
      if(current.trim())out.push(current);
      current='';
      rest=tail;
    }
    if(current.trim())out.push(current);
  }
  return out;
}
// Path-like tokens, removed before denial matching so "src/never.js" cannot decide a clause.
const PATH_TOKEN=/(?:[\w.\\/-]*[\\/][\w.\\/-]+|[\w-]+\.[a-z0-9]{1,8}\b)/giu;

export function stripPaths(text){
  return String(text??'').replace(PATH_TOKEN,token=>' '.repeat(token.length));
}

/** Positions of a global pattern's matches in `text`. */
function positions(pattern,text){
  const out=[];pattern.lastIndex=0;
  for(const match of text.matchAll(pattern))out.push({at:match.index,text:match[0]});
  return out;
}

function isVerbUse(text,index,word,raw=text){
  const start=Math.max(0,index-24);
  const before=text.slice(start,index);
  if(nounPrefix.test(before)||CJK_NOUN_PREFIX.test(before))return false;
  // An explicit read verb and a following code noun identify a symbol such as `add`.
  // Read the original neighbors so removing a path cannot create this construction.
  return !(/^[A-Za-z]+$/u.test(word)&&READ_SYMBOL_PREFIX.test(raw.slice(start,index))&&
    READ_SYMBOL_SUFFIX.test(raw.slice(index+word.length)));
}

/** Does `text` ask for a change, and is it not denied? `raw` is the same text unstripped. */
function sentenceIsWritable(prose,raw=prose){
  const denials=positions(denialPattern,prose);
  for(const verb of positions(verbPattern,prose)){
    if(!isVerbUse(prose,verb.at,verb.text,raw))continue;
    // Only the text before this verb can deny it.
    const before=prose.slice(0,verb.at);
    // A bare 不 governs the attached verb, not a later request in the same clause.
    const prior=denials.filter(denial=>{
      const end=denial.at+denial.text.length;
      return denial.text==='不'?end===verb.at:end<=verb.at;
    });
    if(!prior.length)return true;
    const last=prior.at(-1);
    // stripPaths preserves length, so the same offsets address the raw text. The allowance
    // test needs the raw span: its target may be a path that the prose has blanked out.
    const governed=prose.slice(last.at+last.text.length,verb.at);
    const governedRaw=raw.slice(last.at+last.text.length,verb.at);
    // A second denial inside the governed span is the one that applies: "Don't forget: do
    // not modify src/a.js" is a denial, so the idiom rule must not override it.
    if(positions(denialPattern,governed).length)continue;
    // The denial governs this verb unless it only introduced an idiom or permitted it.
    if(idiomPattern.test(governed))return true;
    // An allowance only counts when it is followed by a write request. "but review the
    // update" names a noun, not a request, so the denial still holds.
    // An allowance only counts when it is followed by a write request. The request test here
    // must accept the SAME two forms the sentence gate accepts — a target, or a target-free
    // implementation verb — or "Do not run tests, but implement pagination." is a request at
    // the gate and a non-request here, and the denial wins. That asymmetry is the same defect
    // two earlier rounds found between hasWriteRequest and hasCapsTarget.
    const allowedText=`${governedRaw}${raw.slice(verb.at)}`;
    if(allowancePattern.test(governed)&&(writeRequestIn(allowedText)||sentenceImplements(allowedText)))return true;
    // `instead` is an allowance that trails the verb, so scanning only the text before it
    // misses the one construction that names the replacement explicitly:
    //   "Do not modify src/a.js, create src/b.js instead."
    // What must be a write request is the text between the DENIAL and the `instead`: the verb
    // this loop is looking at is the one the denial already governs, so including it would
    // make every "do not X instead" an allowance. "Do not modify src/a.js instead." therefore
    // stays a denial (no write request between the denial and `instead`), while
    // "Do not modify a.js, create b.js instead" is a request for b.js.
    const tail=raw.slice(verb.at);
    const clause=tail.split(SENTENCE_BOUNDARY)[0]??'';
    const trailing=/(?:^|[^A-Za-z0-9_-])instead(?![A-Za-z0-9_-])/iu.exec(clause);
    if(trailing&&writeRequestIn(clause.slice(0,trailing.index).replace(new RegExp(`^(?:${VERB_ZH}|${enWord(VERB_EN)})`,'iu'),'')))return true;
  }
  return false;
}

/** Does this sentence name a write verb followed by a target? */
// One definition of "this text asks for a change": a write verb followed by a target.
// There is exactly one implementation, because two rounds of review found the same class
// of bug twice: the request test recognised an ALL-CAPS target and the allowance test did
// not, so `Do not run tests, but create README.` was a request in one place and not in the
// other. Any second predicate here reintroduces that.
//
// The gap between verb and target is bounded by the sentence, not by a fixed character
// count: a target described as "the failing authentication regression in src/b.js" is 40+
// characters after the verb and is still that verb's object.
//
// Two kinds of target, collected separately because one pattern cannot be case-insensitive
// about the verb and case-sensitive about an all-caps identifier:
//   - a path-like word, an extension word, or a Chinese code noun (TARGET);
//   - an ALL-CAPS identifier such as README or MAKEFILE (CAPS_TARGET).
const SCAN_VERB=new RegExp(`(?:${VERB_ZH})|${enWord(VERB_EN)}`,'giu');
const SCAN_TARGET=new RegExp(TARGET,'giu');
const SCAN_CAPS=new RegExp(CAPS_TARGET.source,'gu');

function writeRequestIn(text){
  const raw=String(text??'');
  const verbs=[];
  SCAN_VERB.lastIndex=0;
  for(const match of raw.matchAll(SCAN_VERB)){
    // A determiner directly before the verb makes it a noun ("the patch", "the update"),
    // which is the same rule the clause scan applies; two definitions of "verb" would be
    // the same mistake as two definitions of "target".
    if(isVerbUse(raw,match.index,match[0]))verbs.push({at:match.index,end:match.index+match[0].length});
  }
  if(!verbs.length)return false;
  const targets=[];
  SCAN_TARGET.lastIndex=0;
  for(const match of raw.matchAll(SCAN_TARGET))targets.push({at:match.index,end:match.index+match[0].length});
  SCAN_CAPS.lastIndex=0;
  for(const match of raw.matchAll(SCAN_CAPS))targets.push({at:match.index,end:match.index+match[0].length});
  if(!targets.length)return false;
  // A target anywhere in the same clause counts, before the verb as well as after. English
  // and Chinese both put it first routinely: `In src/a.js fix the bug`, `请把 src/a.js 修复`.
  // Requiring the target AFTER the verb dropped those clauses, the denial decided the task,
  // and the write tools were hidden. The clause is already the unit here, so "anywhere in it"
  // is the right scope — a target in a different clause is not visible to this function.
  return verbs.some(verb=>targets.some(target=>target.at>=verb.end||target.end<=verb.at));
}

function sentenceNamesTarget(sentence){
  return writeRequestIn(sentence);
}

// An implementation verb IS the request. "Implement pagination" names an outcome, not an
// artifact, and requiring a file target made `Do not modify README.md. Implement pagination.`
// read-only — the denied first sentence decided the whole task and the edit tools were
// hidden from real work. These verbs are only in this list because they cannot be used as a
// noun describing an existing thing, which is why `add` is absent: "the add operation" and
// "add logging" are the same word.
const IMPLEMENT_ZH='实现|重构|重写|修补';
const IMPLEMENT_EN='implement|refactor|rewrite';
const implementProbe=new RegExp(`(?:${IMPLEMENT_ZH})|${enWord(IMPLEMENT_EN)}`,'iu');
// "Do not implement pagination." has no target either, so this cannot bypass the denial:
// the clause scan below must still find the verb affirmative.
function sentenceImplements(sentence){
  return implementProbe.test(sentence);
}

// The plugin's own execution tools. A task that names one is asking for a run, which is a
// different verb class from "modify": `Do not modify any files. Use work_exec to run ...`
// forbids edits and requests an execution, so the execution must stay available.
const EXECUTION_TOOL=/(?<![A-Za-z0-9_])(?:work_exec|verified_exec|work_reason|bash|pwsh)(?![A-Za-z0-9_])/iu;
const EXECUTION_CLAUSE=/^\s*(?:(?:请|随后|接着|然后|接下来|再|also|then|please)\s*)*(?:运行|执行|跑一下|(?:run|execute)\s+)\s*\S/iu;

export function isReadOnlyTaskRequest(request){
  const text=String(request??'');
  const prose=stripPaths(text);
  // Both marker checks read the path-stripped prose: a filename such as
  // `scripts/read-only.sh` contains the marker but states nothing about permission.
  const markerPresent=readOnlyMarker.test(prose);
  // The gate is only an optimisation: it must not be able to decide the answer on its own.
  if(!markerPresent&&!new RegExp(DENIAL_ANY,'iu').test(prose))return false;
  // A sentence with a verb but no target states no request ("review the edits in src/a.js"
  // is a read). A sentence with a verb and a target is a request; it decides the answer.
  let sawRequest=false;
  const sentences=splitSentences(text);
  for(const sentence of sentences){
    if(!sentence.trim())continue;
    const sentenceProse=stripPaths(sentence);
    // The gate must accept every verb the sentence scan considers. `verbProbe` covers the
    // write verbs; `implementProbe` covers the implementation verbs that need no target, and
    // `rewrite` is in the second list but not the first (VERB_EN has `write`, and its
    // lookarounds correctly refuse to match inside `rewrite`). Checking only verbProbe here
    // made `Do not rewrite the parser.` skip the clause scan entirely.
    if(!verbProbe.test(sentenceProse)&&!sentenceImplements(sentenceProse))continue;
    // A target is required, OR the verb is one that states the request by itself. Both
    // routes then go through the same clause scan, so a denial still decides either way:
    // "Do not implement pagination." is read-only because the verb is denied, not because it
    // lacks a target.
    if(!sentenceNamesTarget(sentence)&&!sentenceImplements(sentence))continue;
    sawRequest=true;
    // This sentence does name a write. If any sentence names one affirmatively, the task is
    // writable; otherwise it is denied here and the remaining sentences are still checked.
    if(sentenceIsWritable(sentenceProse,sentence))return false;
  }
  // A named execution request survives a denied write. "Do not modify any files. Use
  // work_exec to run the Node program console.log(42)." is a task whose operative verb is
  // outside this classifier's vocabulary, and hiding work_exec from it is the harmful
  // direction — the same rule the marker-only fallback below already states. The execution
  // verb has to be checked before `sawRequest` decides, because the denied sentence is what
  // set it.
  if(!markerPresent&&(EXECUTION_TOOL.test(text)||sentences.some(sentence=>EXECUTION_CLAUSE.test(sentence))))return false;
  if(sawRequest)return true;
  // No tracked write verb with a target. A denial alone does not make the task read-only:
  // "don't use old/node.exe; use the new one to run the program" is a task whose verb
  // (运行/run) is outside this classifier's vocabulary, and hiding the edit tools from it is
  // the harmful direction. Only an explicit read-only instruction decides in that case.
  return markerPresent;
}
