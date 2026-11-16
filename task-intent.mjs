/**
 * Classifies a user request as read-only: no affirmative write request survives its own
 * clause's denial. Exported so the whole denial invariant can be tested directly instead
 * of only through a host prompt, which is what let six successive clause bugs through.
 *
 * Invariants (each has a bidirectional case in test/task-intent.test.mjs):
 * - a denial governs only its own clause; sentence ends and commas split clauses, but a
 *   comma list under one denial ("do not modify, create, or delete a.js") stays whole;
 * - an allowance must follow the denial and must itself be a write clause;
 * - a modal denial's own word ("must" in "must not") is not an allowance;
 * - an idiom denial ("don't forget to") does not deny the verb it introduces;
 * - a write before the denial in the same clause still counts;
 * - an English noun that looks like a verb ("the patch") is not a request.
 */
export function isReadOnlyTaskRequest(request){
  const readOnly=/(?:只读|read[- ]only)|(?:不得|不要|不能|不可|无需|不必|不准|禁止|不允许|不应|请勿|勿|do not|don't|never|must not|mustn't|may not|mayn't|should not|shouldn't|shall not|shan't|cannot|can't|won't|wouldn't|would not|will not|need not|needn't).{0,24}(?:修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch)/iu.test(request);
  if(!readOnly)return false;
  const writeVerb=/(?:修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改|modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch)/iu;
  const deniedWrite=/(?:不得|不要|不能|不可|无需|不必|不准|禁止|不允许|不应|请勿|勿|do not|don't|never|must not|mustn't|may not|mayn't|should not|shouldn't|shall not|shan't|cannot|can't|won't|wouldn't|would not|will not|need not|needn't)/iu;
  // An allowance word must be its own token: in "src/can-edit.js" the `can` is part
  // of a filename, not permission to write, and reading it as permission turned an
  // explicit denial into a writable task.
  const allowedAfterDenial=/(?:^|[^A-Za-z0-9_-])(?:但|但是|不过|然而|而是|需要|允许|可以|请|必须|应当|instead|however|but|should|must|can|may)(?![A-Za-z0-9_-]).{0,40}(?:(?:修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改(?!动|变))|(?:modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch)\b)/iu;
  // A sentence can mention an edit without asking for one: "review the edits in
  // src/a.js" is a read, because "edits" is the object of "review". The English
  // verbs are therefore matched in base form only (\b so "edits"/"edited" do not
  // qualify), and a Chinese or English verb must be followed by a target rather
  // than merely appear. A target can be an extensionless name such as `README`,
  // which is why the target list accepts a path-qualified word, and a separate
  // case-sensitive test accepts an ALL-CAPS name: "create README" is a request,
  // "the edits" is a description. It has to be a separate pattern because the main
  // one is /iu, where [A-Z] would also match lowercase words like "edits".
  const writeRequest=/(?:^|[，,、：:\s])(?:[^。；;\n]{0,8})?(?:(?:修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改(?!动|变))|(?:modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch)\b)[^。；;\n]{0,16}(?:[\w./\\-]+\.[a-z0-9]{1,8}\b|[\w-]*\/[\w.-]+|文件|代码|函数|方法|类|模块|程序|脚本|实现|逻辑|配置|file|code|function|method|class|module|program|script|config)/iu;
  // The ALL-CAPS variant is a separate case-sensitive pattern: the main one is /iu,
  // where [A-Z] would also match lowercase words like "edits". Its English verbs are
  // spelled as explicit letter classes because without the /i flag a plain `create`
  // would miss the sentence-initial "Create README". The \b belongs on the English
  // alternatives only: a CJK verb is a non-word character, so a trailing \b would
  // only match when an ASCII letter follows immediately, and Chinese text normally
  // puts a space before an ASCII name ("创建 README").
  const upperCaseTarget=/(?:^|[，,、：:\s])(?:[^。；;\n]{0,8})?(?:(?:修改|修复|实现|编写|重构|创建|编辑|写入|增加|更新|添加|新增|更改|移除|删除|替换|重写|修补|重命名|改(?!动|变))|[Mm]odify\b|[Ff]ix\b|[Ii]mplement\b|[Ww]rite\b|[Ee]dit\b|[Cc]reate\b|[Dd]elete\b|[Rr]eplace\b|[Uu]pdate\b|[Aa]dd\b|[Cc]hange\b|[Rr]efactor\b|[Rr]emove\b|[Rr]ename\b|[Pp]atch\b)[^。；;\n]{0,16}[A-Z][A-Z0-9_-]{1,30}\b/u;
  // An English noun can look like a write verb: "explain the patch in src/a.js" is a
  // read. A verb preceded by a determiner or possessive is the object of that phrase,
  // so it is not a request; the same check applies to the ALL-CAPS variant.
  const nounLike=/(?:^|\s)(?:a|an|the|this|that|these|those|its|their|his|her|our|your|my|any|some|each|every|no)\s+$/iu;
  const englishVerb=/modify|fix|implement|write|edit|create|delete|replace|update|add|change|refactor|remove|rename|patch/iu;
  const requestMatches=(pattern,text)=>{
    for(const match of text.matchAll(new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g'))){
      // Locate the verb inside the match: the pattern may start at the determiner, so
      // the determiner would otherwise hide the noun use. A verb preceded by "the" is
      // that phrase's object, not a request.
      const verb=match[0].match(englishVerb),verbAt=match.index+(verb?verb.index:0);
      if(!nounLike.test(text.slice(Math.max(0,verbAt-24),verbAt)))return true;
    }
    return false;
  };
  // A denial governs only its own coordinate clause. Sentence ends and every comma
  // separate decisions, but a comma list under one denial must stay whole: a segment
  // joins the previous clause when it starts with a list conjunction, or when the
  // previous clause named a verb but no target.
  const clauses=[];
  for(const raw of request.split(/[。；;\n，,]|\.(?=\s+[A-Z])/u)){
    const previous=clauses.at(-1);
    const continues=/^\s*(?:or\b|nor\b|and\b|以及|或者|或是|或|和)/iu.test(raw)&&previous!==undefined;
    const incomplete=previous!==undefined&&writeVerb.test(previous)&&!requestMatches(writeRequest,previous)&&!requestMatches(upperCaseTarget,previous);
    if(continues||incomplete)clauses[clauses.length-1]+=raw;
    else clauses.push(raw);
  }
  return !clauses.some(clause=>{
    if(!writeVerb.test(clause))return false;
    if(!requestMatches(writeRequest,clause)&&!requestMatches(upperCaseTarget,clause))return false;
    if(!deniedWrite.test(clause))return true;
    // An allowance must follow the denial and must itself be a write clause. A
    // repeated denial is not permission ("but do not modify a.js"). Match the denial
    // first: searching from its start would read the "must" of "must not" as an
    // allowance and reject the clause before a later real allowance.
    const denialAt=clause.search(deniedWrite),prefix=clause.slice(0,denialAt);
    // The text before the first denial is not governed by it: "Fix a.js, do not
    // modify b.js" asks for the first edit and forbids only the second. A denial
    // that only introduces an idiom ("don't forget to", "do not hesitate to") does
    // not deny the write verb it precedes.
    if(/^\s*(?:forget|hesitate|fail|neglect)\b|^\s*(?:忘记|忘了|犹豫)/iu.test(clause.slice(denialAt).replace(deniedWrite,'')))return true;
    if(writeVerb.test(prefix)&&(requestMatches(writeRequest,prefix)||requestMatches(upperCaseTarget,prefix)))return true;
    const after=clause.slice(denialAt),denial=deniedWrite.exec(after);
    if(!denial)return true;
    const remaining=after.slice(denial[0].length),allowanceAt=remaining.search(allowedAfterDenial);
    if(allowanceAt<0)return false;
    return !deniedWrite.test(remaining.slice(allowanceAt));
  });
}
