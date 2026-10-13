const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { loadSource, root } = require("./service-test-utils.cjs");

// Test the module contract independently from the vendor build step.
const { analyzeProjectStructure } = loadSource("src/projectStructure.ts", {
  [path.join(root, "resources", "context", "yaml.cjs")]: require("yaml"),
});
const analyze = (filename, text) => JSON.parse(JSON.stringify(analyzeProjectStructure(filename, text)));
const references = (result, kind) => result.references.filter(reference => reference.kind === kind);

test("Russian Element YAML captures identity, generics, handlers and expression candidates", () => {
  const result = analyze("Форма.yaml", [
    "ВидЭлемента: КомпонентИнтерфейса", "Ид: 83b22b30-5f1f-4812-a0cf-dfc72eb621f2", "Имя: ФормаРедактирования",
    "Импорт:", "  - Общие", "  - Стд::Интерфейс", "Наследует:", "  Тип: Форма<Булево>",
    "  Содержимое:", "    - Имя: Применить", "      Тип: Кнопка", "      ПриНажатии: Применить",
    "      Значение: =ДанныеРедактирования.Замещающий", "      Заголовок: =ЗаголовокФормы()",
  ].join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.element, { kind: "КомпонентИнтерфейса", id: "83b22b30-5f1f-4812-a0cf-dfc72eb621f2", name: "ФормаРедактирования" });
  assert.deepEqual(references(result, "import").map(reference => reference.name), ["Общие", "Стд::Интерфейс"]);
  assert.deepEqual(references(result, "type").map(reference => reference.name), ["Форма", "Булево", "Кнопка"]);
  assert.deepEqual(references(result, "handler"), [{ name: "Применить", kind: "handler", startLine: 12, endLine: 12, yamlPath: "$.Наследует.Содержимое[0].ПриНажатии" }]);
  assert.deepEqual(references(result, "expression").map(reference => reference.name), ["ДанныеРедактирования.Замещающий", "ЗаголовокФормы"]);
  assert.deepEqual(result.symbols[0], { name: "ФормаРедактирования", kind: "yaml-element", startLine: 1, endLine: 14, selectionLine: 3, selectionCharacter: 5 });
  assert.deepEqual(result.symbols[1], { name: "Применить", kind: "yaml-name", startLine: 10, endLine: 14, selectionLine: 10, selectionCharacter: 11 });
});

test("English fields keep same-name declarations separate and retain callback paths", () => {
  const result = analyze("Form.YML", [
    "ElementKind: InterfaceComponent", "Name: Form", "Id: form-id", "Inherits:", "  Type: ObjectForm<Orders.Object, Boolean>",
    "  Items:", "    - Name: Save", "      Handler: Save", "    - Name: Save", "      OnClick: Actions.Save",
    "      Procedure: OnSave", "      Callback: AfterSave", "      HandleClick: false", "      'odd.key': = Query()",
  ].join("\n"));
  assert.equal(result.symbols.filter(symbol => symbol.name === "Save").length, 2);
  assert.deepEqual(result.symbols.filter(symbol => symbol.name === "Save").map(symbol => [symbol.startLine, symbol.endLine]), [[7, 8], [9, 14]]);
  assert.deepEqual(references(result, "handler").map(reference => reference.name), ["Save", "Actions.Save", "OnSave", "AfterSave"]);
  assert.deepEqual(references(result, "type").map(reference => reference.name), ["ObjectForm", "Orders.Object", "Boolean"]);
  assert.equal(references(result, "expression")[0].yamlPath, '$.Inherits.Items[1]["odd.key"]');
});

test("plain configurations are not identified as Element project elements", () => {
  for (const source of ["Name: Build\nId: service\nType: job", "kind: Deployment\nmetadata:\n  name: app", "ВидЭлемента: Модуль", "Имя: Config\nОписание: test"]) {
    assert.equal(analyze("config.yaml", source).element, undefined);
  }
  assert.equal(analyze("config.yaml", "Name: Build").symbols[0].kind, "yaml-name");
  assert.deepEqual(analyze("config.json", '{"Name":"Build"}'), { symbols: [], references: [], errors: [] });
});

test("multiline YAML values use source ranges and do not index comments or string contents as expressions", () => {
  const source = [
    "# Handler: CommentFake", "ElementKind: InterfaceComponent", 'Name: "Form"', "Value: >-", "  = not IsEmpty(",
    '    Object.Reference, "Fake()")', "Handler: |", "  Save", "Visible: '= Check() and True // CommentFake()'",
    'Description: "Handler: Fake"', "Other: '='", "AfterSave: Done", "ПослеСоздания: Инициализировать",
  ].join("\r\n") + "\r\n";
  const result = analyze("Form.yaml", source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.symbols[0].selectionCharacter, 7);
  assert.equal(result.symbols[0].endLine, 13);
  assert.deepEqual(references(result, "expression"), [
    { name: "IsEmpty", kind: "expression", startLine: 4, endLine: 6, yamlPath: "$.Value" },
    { name: "Object.Reference", kind: "expression", startLine: 4, endLine: 6, yamlPath: "$.Value" },
    { name: "Check", kind: "expression", startLine: 9, endLine: 9, yamlPath: "$.Visible" },
  ]);
  assert.deepEqual(references(result, "handler").map(reference => [reference.name, reference.startLine, reference.endLine]), [["Save", 7, 8], ["Инициализировать", 13, 13]]);
});

test("handler expressions remain expression candidates, never resolved handler names", () => {
  const result = analyze("Form.yaml", "ПриНажатии: =Применить(Данные)\nОбработчик: Применить\nНаследует: Стд::Форма<Объект>\n");
  assert.deepEqual(references(result, "expression").map(reference => reference.name), ["Применить", "Данные"]);
  assert.deepEqual(references(result, "handler").map(reference => reference.name), ["Применить"]);
  assert.deepEqual(references(result, "type").map(reference => reference.name), ["Стд::Форма", "Объект"]);
});

test("aliases are traversed with occurrence ranges, cycle and expansion limits", () => {
  const result = analyze("Form.yaml", ["Common: &h Save", "Handler: *h", "Defaults: &d", "  Type: Button", "Copy: *d"].join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(references(result, "handler"), [{ name: "Save", kind: "handler", startLine: 2, endLine: 2, yamlPath: "$.Handler" }]);
  assert.deepEqual(references(result, "type").map(reference => [reference.name, reference.startLine, reference.yamlPath]), [["Button", 4, "$.Defaults.Type"], ["Button", 5, "$.Copy.Type"]]);
  assert.match(analyze("cycle.yaml", "Loop: &loop [*loop]").errors.join(" "), /циклическая/);
  assert.match(analyze("missing.yaml", "Handler: *missing").errors.join(" "), /не найден якорь/);
  const large = analyze("aliases.yaml", "Base: &base {Handler: Save}\nCopies: [" + Array(200).fill("*base").join(", ") + "]");
  assert.match(large.errors.join(" "), /128/);
  assert.ok(large.references.length <= 129);
  const deep = analyze("deep.yaml", Array.from({ length: 70 }, (_, index) => "  ".repeat(index) + "Node:").join("\n"));
  assert.match(deep.errors.join(" "), /64/);
});

test("duplicate and invalid YAML produce diagnostics without crashing or silently choosing an identity", () => {
  const duplicate = analyze("duplicate.yaml", "ElementKind: Module\nName: First\nName: Second\n");
  assert.ok(duplicate.errors.length > 0);
  assert.equal(duplicate.element, undefined);
  assert.equal(duplicate.symbols.length, 2);
  const bilingual = analyze("duplicate.yaml", "ElementKind: Module\nName: First\nИмя: Second\n");
  assert.equal(bilingual.element, undefined);
  assert.match(bilingual.errors.join(" "), /неоднозначное/);
  for (const source of ["Name: [broken", "Type: {broken", "---\nName: One\n---\nName: Two"]) {
    assert.ok(analyze("broken.yaml", source).errors.length > 0);
  }
});

test("Russian and English lexical methods retain exact name columns and same-name occurrences", () => {
  const result = analyze("Module.xbsl", [
    "метод Применить(): Булево", "    если Данные", "        возврат Истина", "    ;", "    возврат Ложь", ";",
    "method Применить(): Boolean", "    return True", ";",
    "статический метод Сохранить(Значение: Строка)", "    Записать(Значение)", ";",
  ].join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.symbols, [
    { name: "Применить", kind: "lexical-method", startLine: 1, endLine: 6, selectionLine: 1, selectionCharacter: 6 },
    { name: "Применить", kind: "lexical-method", startLine: 7, endLine: 9, selectionLine: 7, selectionCharacter: 7 },
    { name: "Сохранить", kind: "lexical-method", startLine: 10, endLine: 12, selectionLine: 10, selectionCharacter: 18 },
  ]);
});

test("comments, quoted text and longer Unicode words never create lexical declarations", () => {
  const result = analyze("Module.xbsl", [
    "// метод Ложный()", "/*", "method Fake()", ";", "*/", 'val Text = "', "метод ВнутриСтроки()", '"',
    'val Escaped = "say \\"метод Fake2()\\""', 'val Doubled = """method Fake3()"""',
    "неметод Нет()", "methodical No()", "методЁ Нет()", "метод Хороший() // метод Другой()", "    // ;", "; // end",
  ].join("\n"));
  assert.deepEqual(result.symbols.map(symbol => symbol.name), ["Хороший"]);
  assert.deepEqual([result.symbols[0].startLine, result.symbols[0].endLine], [14, 16]);
});

test("XBSL indexes imports, declarations and nested methods without collapsing names", () => {
  const result = analyze("Types.XBSL", [
    "импорт Стд::Коллекции", "import Common // extra", "структура Данные", "    метод Сохранить()", "        Вернуть()", "    ;", ";",
    "object Item", "\tmethod Save()", "\t\treturn", "\t;", ";", "перечисление Статус", "    Открыт", ";",
    "enum Status", "    Open", ";", "type Identifier = String", "тип Код = Строка",
  ].join("\n"));
  assert.deepEqual(result.references, [
    { name: "Стд::Коллекции", kind: "import", startLine: 1, endLine: 1 },
    { name: "Common", kind: "import", startLine: 2, endLine: 2 },
  ]);
  assert.deepEqual(result.symbols.map(symbol => [symbol.name, symbol.kind, symbol.startLine, symbol.endLine]), [
    ["Данные", "lexical-structure", 3, 7], ["Сохранить", "lexical-method", 4, 6],
    ["Item", "lexical-object", 8, 12], ["Save", "lexical-method", 9, 11],
    ["Статус", "lexical-enum", 13, 15], ["Status", "lexical-enum", 16, 18],
    ["Identifier", "lexical-type", 19, 19], ["Код", "lexical-type", 20, 20],
  ]);
  assert.equal(result.symbols.find(symbol => symbol.name === "Save").selectionCharacter, 8);
});

test("unfinished and ambiguously indented methods are explicitly partial and stop before the next declaration", () => {
  const result = analyze("Partial.xbsl", [
    "method First()", "    Work()", "@Handler", "method Next()", "    return", ";",
    "метод Неровный()", "если Истина", "    Сделать()", ";", ";", "метод Незавершённый(", "    Аргумент: Число",
  ].join("\n"));
  assert.deepEqual(result.symbols.map(symbol => [symbol.name, symbol.kind, symbol.endLine]), [
    ["First", "lexical-method-partial", 2], ["Next", "lexical-method", 6],
    ["Неровный", "lexical-method-partial", 11], ["Незавершённый", "lexical-method-partial", 13],
  ]);
  assert.match(analyze("Broken.xbsl", 'method Work()\n    val Text = "unfinished').errors.join(" "), /частичный/);
  assert.deepEqual(analyze("Empty.xbsl", "// end").errors, []);
});

test("abstract declarations and CRLF offsets remain lexical and do not consume following methods", () => {
  const result = analyze("Abstract.xbsl", ["abstract method Read(", "    Key: String): Object", "абстрактный метод Записать()", "method Work()", "    Run()", ";", ""].join("\r\n"));
  assert.deepEqual(result.symbols.map(symbol => [symbol.name, symbol.kind, symbol.startLine, symbol.endLine]), [
    ["Read", "lexical-abstract-method", 1, 2], ["Записать", "lexical-abstract-method", 3, 3], ["Work", "lexical-method", 4, 6],
  ]);
});

test("UTF-8 BOM does not hide a first-line method or import", () => {
  const result = analyze("Bom.xbsl", "\uFEFFметод Выполнить()\r\n    Работа()\r\n;\r\n");
  assert.deepEqual(result.symbols, [
    { name: "Выполнить", kind: "lexical-method", startLine: 1, endLine: 3, selectionLine: 1, selectionCharacter: 7 },
  ]);
  assert.deepEqual(analyze("Bom.xbsl", "\uFEFFimport Std::Time").references, [
    { name: "Std::Time", kind: "import", startLine: 1, endLine: 1 },
  ]);
});

test("real native AST supplies exact annotated ranges for conservative lexical candidates", {
  skip: !process.env.CODEX_NATIVE_AST_TEST_JAR,
}, async t => {
  const { NativeXbslAstService, collectNativeAstSymbols } = loadSource("src/nativeXbslAstService.ts");
  const service = new NativeXbslAstService(root, { info() {}, warn() {}, error() {} }, {
    parserJarPath: process.env.CODEX_NATIVE_AST_TEST_JAR,
    timeoutMs: 30000,
  });
  t.after(() => service.dispose());
  const source = [
    "@Обработчик",
    "метод Рассчитать(",
    "    Права: ЧитаемыйМассив<Право.Объект>",
    "): ЧитаемоеСоответствие<Право.Объект, ЧитаемаяКоллекция<Ключ.Объект>>",
    "    возврат <Право.Объект, Массив<Ключ.Объект>>{:}",
    ";",
    "",
    "@НаКлиенте абстрактный метод Компонент(): ОписаниеКомпонента",
  ].join("\n");
  const lexical = analyze("Example.xbsl", source);
  const candidate = lexical.symbols.find(symbol => symbol.name === "Рассчитать");
  assert.ok(candidate.kind.startsWith("lexical-"));
  const ast = await service.parse(source);
  assert.equal(ast.status, "ready");
  assert.equal(ast.partial, false);
  assert.equal(ast.diagnostics.length, 0);
  assert.equal(ast.semanticBound, false);
  const methods = JSON.parse(JSON.stringify(collectNativeAstSymbols(ast))).filter(symbol => symbol.kind === "method");
  assert.deepEqual(methods.map(symbol => [symbol.name, symbol.startLine, symbol.endLine]), [
    ["Рассчитать", 1, 6], ["Компонент", 8, 8],
  ]);
  assert.equal(source.slice(methods[0].startOffset, methods[0].endOffset), source.split("\n").slice(0, 6).join("\n"));
  assert.ok(methods[0].startLine <= candidate.selectionLine && methods[0].endLine >= candidate.selectionLine);
  const abstract = ast.root.children.find(node => node.attributes.name === "Компонент");
  assert.equal(abstract.kind, "Method");
  assert.equal(abstract.role, "abstractMethods");
});
