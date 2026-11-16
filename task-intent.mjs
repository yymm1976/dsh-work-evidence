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
 * Two lexical guards remain, both closed judgments about a character position:
 *   1. a verb preceded by a determiner is a noun ("the patch", "the update");
 *   2. English words match whole words only ("whenever", "bugfix", "prefix").
 */

const VERB_ZH='修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改';
const VERB_EN='modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch';
// 不可 is deliberately absent: it is far more often part of an adjective (不可用, 不可靠,
// 不可避免) than a denial, and including it classified "执行程序并保留真实不可用结果" as
// read-only. 不能被/不可修改 are covered by 不能 plus the verb scan.
const DENIAL_ZH='不得|不要|不能|无需|不必|不用|不准|不需要|严禁|禁止|不允许|不应|请勿|勿|别|莫';
const DENIAL_EN="do not|don't|never|must not|mustn't|may not|mayn't|should not|shouldn't|shall not|shan't|cannot|can't|won't|wouldn't|would not|will not|need not|needn't|not allowed to|not supposed to|make sure not to|be sure not to|no need to|there is no need to";
// A denial that only introduces an idiom does not deny the verb after it.
const IDIOM='forget|hesitate|fail|neglect|忘记|忘了|犹豫';
// A marker that turns a preceding denial into permission.
const ALLOWANCE='但|但是|不过|然而|而是|反而|只|仅|需要|允许|可以|请|必须|应当|instead|however|but|should|must|can|may|only';
// A target: a path-like word, an extensionless name, or a Chinese code noun.
const TARGET='[\\w./\\\\-]+\\.[a-z0-9]{1,8}|[\\w-]*\\/[\\w.-]+|文件|代码|函数|方法|类|模块|程序|脚本|实现|逻辑|配置|file|code|function|method|class|module|program|script|config|anything|everything|任何|一切';

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
const readOnlyMarker=/(?:只读|read[- ]only)/iu;
// Sentence boundaries. A period splits only before a capital so "src/a.js" survives.
const SENTENCE_BOUNDARY=/[。！？；;\n]|[.!?](?!\s*[a-z0-9])/u;
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

/**
 * Is the verb at `index` a request rather than a noun? Only a preceding determiner makes
 * it a noun; that is the one noun construction this classifier claims to recognise.
 */
const isVerbUse=(text,index)=>!nounPrefix.test(text.slice(Math.max(0,index-24),index));

/** Does `text` ask for a change, and is it not denied? `raw` is the same text unstripped. */
function sentenceIsWritable(prose,raw=prose){
  const denials=positions(denialPattern,prose);
  for(const verb of positions(verbPattern,prose)){
    if(!isVerbUse(prose,verb.at))continue;
    // Only the text before this verb can deny it.
    const before=prose.slice(0,verb.at);
    const prior=denials.filter(denial=>denial.at+denial.text.length<=verb.at);
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
    if(allowancePattern.test(governed)&&hasWriteRequest(`${governedRaw}${raw.slice(verb.at)}`))return true;
  }
  return false;
}

/** Does this sentence name a write verb followed by a target? */
function sentenceNamesTarget(sentence){
  // The target test runs on the ORIGINAL sentence: stripPaths replaces paths with spaces,
  // so testing the prose would erase exactly the target it is looking for.
  const targetPattern=new RegExp(`(?:(?:${VERB_ZH})|(?:${enWord(VERB_EN)}))[^。！？；;\\n]{0,32}(?:${TARGET})`,'iu');
  if(targetPattern.test(sentence))return true;
  // An ALL-CAPS name is a target even without an extension: "create README".
  const capsPattern=new RegExp(`(?:(?:${VERB_ZH})|(?<![A-Za-z0-9_])(?:${VERB_EN})(?![A-Za-z0-9_]))[^。！？；;\\n]{0,32}[A-Z][A-Z0-9_-]{1,30}(?![A-Za-z0-9_])`,'u');
  return capsPattern.test(sentence);
}

/** Does `text` contain an affirmative write request? */
function hasWriteRequest(text){
  const raw=String(text??'');
  // The target test is on the raw text (stripPaths would erase the path), while the
  // noun guard is on the stripped text (a path must not look like a determiner phrase).
  const targetPattern=new RegExp(`(?:(?:${VERB_ZH})|(?:${enWord(VERB_EN)}))[^。！？；;\\n]{0,32}(?:${TARGET})`,'iu');
  if(targetPattern.test(raw))return true;
  const capsPattern=new RegExp(`(?:(?:${VERB_ZH})|(?<![A-Za-z0-9_])(?:${VERB_EN})(?![A-Za-z0-9_]))[^。！？；;\\n]{0,32}[A-Z][A-Z0-9_-]{1,30}(?![A-Za-z0-9_])`,'u');
  return capsPattern.test(raw);
}

export function isReadOnlyTaskRequest(request){
  const text=String(request??'');
  const prose=stripPaths(text);
  // The gate is only an optimisation: it must not be able to decide the answer on its own.
  const denialPresent=new RegExp(DENIAL_ANY,'iu').test(prose);
  if(!readOnlyMarker.test(text)&&!denialPresent)return false;
  // A sentence with a verb but no target states no request ("review the edits in src/a.js"
  // is a read). A sentence with a verb and a target is a request; it decides the answer.
  let sawRequest=false;
  for(const sentence of text.split(SENTENCE_BOUNDARY)){
    if(!sentence.trim())continue;
    const sentenceProse=stripPaths(sentence);
    if(!verbProbe.test(sentenceProse))continue;
    if(!sentenceNamesTarget(sentence))continue;
    sawRequest=true;
    // This sentence does name a write. If any sentence names one affirmatively, the task is
    // writable; otherwise it is denied here and the remaining sentences are still checked.
    if(sentenceIsWritable(sentenceProse,sentence))return false;
  }
  if(sawRequest)return true;
  // No tracked write verb with a target. A denial alone does not make the task read-only:
  // "don't use old/node.exe; use the new one to run the program" is a task whose verb
  // (运行/run) is outside this classifier's vocabulary, and hiding the edit tools from it is
  // the harmful direction. Only an explicit read-only marker decides in that case.
  return readOnlyMarker.test(text);
}
