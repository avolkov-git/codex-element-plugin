const assert = require("node:assert/strict");
const {
  parseMarkdownFileTarget,
  workspaceRelativePathCandidates
} = require("../dist/markdownFileLink");

assert.deepEqual(
  parseMarkdownFileTarget("f:\\1c-element-workspace\\workspace\\avolkov\\ActiveDirectory\\Безопасность.xbsl:48"),
  {
    path: "f:\\1c-element-workspace\\workspace\\avolkov\\ActiveDirectory\\Безопасность.xbsl",
    line: 48
  }
);
assert.deepEqual(
  parseMarkdownFileTarget("f:\\workspace\\module.xbsl:48:7"),
  { path: "f:\\workspace\\module.xbsl", line: 48, column: 7 }
);
assert.deepEqual(
  parseMarkdownFileTarget("file:///f:/workspace/module.xbsl#L12C4"),
  { path: "file:///f:/workspace/module.xbsl", line: 12, column: 4 }
);
assert.deepEqual(
  parseMarkdownFileTarget("/srv/element/workspace/app/module.xbsl:9"),
  { path: "/srv/element/workspace/app/module.xbsl", line: 9 }
);

const fullPath = "f:\\server-instance\\data\\workspace\\avolkov\\ActiveDirectory\\Безопасность\\БезопасностьActiveDirectory.xbsl";
assert.deepEqual(
  workspaceRelativePathCandidates(fullPath, "workspace"),
  ["avolkov/ActiveDirectory/Безопасность/БезопасностьActiveDirectory.xbsl"]
);
assert.deepEqual(
  workspaceRelativePathCandidates(fullPath, "ActiveDirectory"),
  [
    "avolkov/ActiveDirectory/Безопасность/БезопасностьActiveDirectory.xbsl",
    "Безопасность/БезопасностьActiveDirectory.xbsl"
  ]
);

console.log("markdown-file-link-check: ok");
