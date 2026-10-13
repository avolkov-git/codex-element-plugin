# Native XBSL AST Adapter

This directory contains Codex's small reflection-based Java helper, its source,
and the build hashes. It does not contain or redistribute Element parser code.
The runtime loads `BslParserHelper` from the installed official AppEngine LSP JAR.
It does not launch, restart, or modify the IDE's Language Server.

`NativeXbslAstService.parse(source, { signal })` starts one persistent worker on
demand. The result includes every EMF containment node, plain attributes,
containment roles, UTF-16 source offsets (end exclusive), one-based lines, and
syntax diagnostics. Recovery nodes without positions use offsets `-1` and lines
`0`. `partial: true` identifies a recovered tree for invalid/incomplete source.
Arbitrary-precision numeric attributes are strings to avoid JavaScript rounding.
Native `java.time.Duration` literals use that immutable JDK type's ISO 8601
representation. `attributeValueTypes.value` records the native class, and
`attributeSources.value` preserves the exact source lexeme (for example `1ч`).
Other opaque literal values remain listed in `omittedAttributes`, with the same
native-class/source metadata as a fallback. No generic `toString()` or semantic
resolution is used to invent a primitive value for an unknown runtime object.

This is a full **syntax containment tree**, not a resolved semantic model.
`semanticBound` is always false. Non-containment references are not traversed;
opaque runtime/cache attributes are named in `omittedAttributes`. Type names or
call names do not prove that the corresponding types/methods exist. Use the
running Language Server for semantic resolution.

Discovery order: an explicitly configured parser path (for tests),
`LSP_SERVER_PATH/repo`, native VS Code extension locations, then sibling
`@1c-appengine-plugin` / `1c-appengine-plugin` installations. An explicitly set
`LSP_SERVER_PATH` is authoritative. Ambiguous JAR directories are rejected.
Java discovery follows `E1C_IDE_JAVA_HOME`, `JAVA_HOME`, then `PATH`.
Users only need the Java runtime already required by Element, not `javac`.

The worker is bounded to a 256 MiB Java heap, 1 MiB source, 50,000 nodes, 256
containment levels, and 16 MiB output. It never silently returns a truncated tree.
The service has a bounded queue, request deadlines including queue time,
cancellation, an LRU cache keyed by source hash and parser fingerprint, and idle
process disposal. The default cache budget is 32 MiB of serialized results.
Source is sent over stdin; it is not written to a temporary file or logged.

Build from source with JDK 11 or later:

```sh
node scripts/build-native-ast.js --rebuild
```

Normal builds reuse the current checked artifact, including on JRE-only hosts:

```sh
node scripts/build-native-ast.js
node scripts/build-native-ast.js --check
```

`--check` validates both SHA-256 hashes without invoking Java tools. The helper is
compiled with `--release 11`. Integration tests against an installed real parser:

```sh
CODEX_NATIVE_AST_TEST_JAR=/path/to/com.e1c.g5rt.lsp.server.appengine-VERSION.jar \
  node --test tests/native-xbsl-ast.test.cjs
```
