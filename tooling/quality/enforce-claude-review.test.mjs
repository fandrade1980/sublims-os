import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const cli = resolve(import.meta.dirname, "enforce-claude-review.mjs");
const approved = { summary: "Sem achados críticos", critical_count: 0, findings: [] };

function runExecution(t, events, conclusion = "success", fallback = "", options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sublims-claude-execution-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claude-execution-output.json");
  writeFileSync(file, typeof events === "string" ? events : JSON.stringify(events));
  options.prepare?.({ dir, file });
  const nodeArgs = options.nodeArgs?.({ dir, file }) ?? [];
  return spawnSync(process.execPath, [...nodeArgs, cli], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: dir,
      CLAUDE_EXECUTION_FILE: typeof options.file === "function" ? options.file({ dir, file }) : options.file ?? file,
      CLAUDE_ACTION_CONCLUSION: conclusion,
      CLAUDE_REVIEW_JSON: fallback
    }
  });
}

function resultEvent(result = approved) {
  return { type: "result", subtype: "success", is_error: false, result: JSON.stringify(result) };
}

test("aceita somente o JSON textual do único evento final de sucesso", (t) => {
  const result = runExecution(t, [{ type: "assistant", message: "progresso" }, resultEvent()]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nenhum crítico/i);
});

test("recusa evento final inválido mesmo com fallback legado válido", (t) => {
  const result = runExecution(t, [{ type: "assistant", message: JSON.stringify(approved) }], "success", JSON.stringify(approved));
  assert.notEqual(result.status, 0, "mensagem intermediária ou fallback não é veredito");
  assert.match(result.stderr, /inconclusiva/i);
});

const invalidExecutions = [
  ["conclusion failure", [resultEvent()], "failure"],
  ["evento result repetido", [resultEvent(), resultEvent()]],
  ["result não final", [resultEvent(), { type: "assistant", message: "depois" }]],
  ["subtype incompatível", [{ ...resultEvent(), subtype: "error_max_turns" }]],
  ["is_error verdadeiro", [{ ...resultEvent(), is_error: true }]],
  ["is_error ausente", [{ type: "result", subtype: "success", result: JSON.stringify(approved) }]],
  ["result ausente", [{ type: "result", subtype: "success", is_error: false }]],
  ["result não textual", [{ ...resultEvent(), result: approved }]],
  ["result vazio", [{ ...resultEvent(), result: "" }]],
  ["prosa antes do JSON", [{ ...resultEvent(), result: `Resposta: ${JSON.stringify(approved)}` }]],
  ["Markdown ao redor do JSON", [{ ...resultEvent(), result: `\`\`\`json\n${JSON.stringify(approved)}\n\`\`\`` }]],
  ["JSON parcial", [{ ...resultEvent(), result: JSON.stringify(approved).slice(0, -1) }]],
  ["array no lugar do objeto", [{ ...resultEvent(), result: "[]" }]],
  ["estrutura incompleta", [resultEvent({ summary: "resumo", critical_count: 0 })]],
  ["contagem divergente", [resultEvent({ summary: "resumo", critical_count: 1, findings: [] })]],
  ["array de eventos vazio", []],
  ["evento final nulo", [null]],
  ["evento de topo não é array", { ...resultEvent() }],
  ["arquivo JSON inválido", "{incompleto"]
];

for (const [name, events, conclusion = "success"] of invalidExecutions) {
  test(`recusa ${name} como revisão inconclusiva`, (t) => {
    const result = runExecution(t, events, conclusion, JSON.stringify(approved));
    assert.notEqual(result.status, 0, `${name} não pode aprovar`);
    assert.match(result.stderr, /inconclusiva/i);
    assert.doesNotMatch(result.stdout + result.stderr, /Resposta:|resumo|progresso/);
  });
}

test("achado crítico validado bloqueia com classificação própria", (t) => {
  const finding = { severity: "critical", title: "ACHADO_PRIVADO", evidence: "SEGREDO", recommendation: "Corrigir" };
  const result = runExecution(t, [resultEvent({ summary: "SEGREDO", critical_count: 1, findings: [finding] })]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /crítico bloqueia/i);
  assert.doesNotMatch(result.stdout + result.stderr, /SEGREDO|ACHADO_PRIVADO/);
});

test("não revela conteúdo ou caminho de arquivo de execução inseguro", (t) => {
  const result = runExecution(t, [resultEvent()], "success", "", { file: join(tmpdir(), "SEGREDO_FORA.json") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
  assert.doesNotMatch(result.stdout + result.stderr, /SEGREDO_FORA/);
});

test("rejeita arquivo de execução ausente dentro de RUNNER_TEMP", (t) => {
  const result = runExecution(t, [resultEvent()], "success", "", {
    file: ({ dir }) => join(dir, "arquivo-que-nao-existe.json")
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
});

test("rejeita artefato maior que o limite sem ler seu conteúdo", (t) => {
  const result = runExecution(t, [resultEvent()], "success", "", {
    prepare: ({ file }) => writeFileSync(file, "X".repeat(16 * 1024 * 1024 + 1))
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
  assert.doesNotMatch(result.stdout + result.stderr, /X{32}/);
});

test("rejeita bytes UTF-8 inválidos no artefato", (t) => {
  const result = runExecution(t, [resultEvent()], "success", "", {
    prepare: ({ file }) => {
      const bytes = Buffer.from(JSON.stringify([{ type: "assistant", message: "MARKER" }, resultEvent()]));
      bytes[bytes.indexOf("MARKER")] = 0xff;
      writeFileSync(file, bytes);
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
});

test("rejeita symlink para o artefato mesmo dentro de RUNNER_TEMP", (t) => {
  let link;
  let unavailable = false;
  const result = runExecution(t, [resultEvent()], "success", "", {
    prepare: ({ dir, file }) => {
      link = join(dir, "link.json");
      try {
        symlinkSync(file, link);
      } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") {
          t.skip("criação de symlink indisponível neste Windows");
          unavailable = true;
          return;
        }
        throw error;
      }
    },
    file: () => link
  });
  if (unavailable) return;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
});

test("rejeita symlink em diretório ancestral do artefato", (t) => {
  let alias;
  let unavailable = false;
  const result = runExecution(t, [resultEvent()], "success", "", {
    prepare: ({ dir }) => {
      alias = join(dir, "alias");
      try {
        symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") {
          t.skip("criação de symlink indisponível neste Windows");
          unavailable = true;
          return;
        }
        throw error;
      }
    },
    file: () => join(alias, "claude-execution-output.json")
  });
  if (unavailable) return;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
});

test("falha de fechamento do arquivo permanece inconclusiva e não ecoa o erro", (t) => {
  let preload;
  const result = runExecution(t, [resultEvent()], "success", "", {
    prepare: ({ dir }) => {
      preload = join(dir, "close-fault.mjs");
      writeFileSync(preload, [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        'const originalClose = fs.closeSync;',
        'fs.closeSync = (...args) => {',
        '  if (new Error().stack.includes("enforce-claude-review.mjs")) throw new Error("SEGREDO_NO_CLOSE");',
        '  return originalClose(...args);',
        '};',
        'syncBuiltinESMExports();'
      ].join("\n"));
    },
    nodeArgs: () => ["--import", pathToFileURL(preload).href]
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inconclusiva/i);
  assert.doesNotMatch(result.stdout + result.stderr, /SEGREDO_NO_CLOSE/);
});
