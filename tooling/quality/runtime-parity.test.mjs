import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowFile = resolve(projectRoot, ".github/workflows/pr-gates.yml");

const BASE_SHA_REF = "${{ github.event.pull_request.base.sha }}";
const HEAD_SHA_REF = "${{ github.event.pull_request.head.sha }}";
// Só conta como execução o binário em posição de comando: início da linha ou
// logo após um operador de shell. Menção em argumento, texto ou comentário não conta.
const COMMAND_POSITION = /(?:^|&&|\|\||[;|(])\s*(?:node|npm|npx|corepack)(?=\s|$)/;

function stripComment(line) {
  return line.replace(/(^|\s)#.*$/, "$1");
}

function usesNodeRuntime(body) {
  return body
    .split(/\r?\n/)
    .map(stripComment)
    .some((line) => line.trim() !== "" && COMMAND_POSITION.test(line));
}

function workflowPath(environment = process.env, cwd = process.cwd()) {
  const candidatePath = "candidate/.github/workflows/pr-gates.yml";
  if (environment.CI === "true") {
    assert.ok(
      environment.RUNTIME_PARITY_WORKFLOW,
      "CI precisa informar RUNTIME_PARITY_WORKFLOW para validar o workflow candidato"
    );
    assert.equal(
      environment.RUNTIME_PARITY_WORKFLOW,
      candidatePath,
      `RUNTIME_PARITY_WORKFLOW precisa ser ${candidatePath} em CI`
    );
    return resolve(cwd, candidatePath);
  }
  if (environment.RUNTIME_PARITY_WORKFLOW) return resolve(cwd, environment.RUNTIME_PARITY_WORKFLOW);
  return workflowFile;
}

function readWorkflow() {
  return readFileSync(workflowPath(), "utf8");
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

// A primeira linha de um passo carrega o marcador de item (`- `). Para comparar
// indentação de chaves, ela é normalizada como se fosse uma chave comum.
function isFirstLine(position) {
  return position === 0;
}

function effectiveIndent(line, first) {
  if (first) {
    const marker = line.match(/^(\s*)-\s+/);
    if (marker) return marker[1].length + 2;
  }
  return indentOf(line);
}

function keyLine(line, first) {
  return first ? line.replace(/^(\s*)-\s+/, "$1  ") : line;
}

function jobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*jobs:\s*$/.test(line));
  assert.ok(start >= 0, "o workflow precisa declarar jobs");
  const jobsIndent = indentOf(lines[start]);
  const result = [];
  let current = null;
  let jobIndent = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    if (indent <= jobsIndent) break;
    if (jobIndent === null) jobIndent = indent;
    if (indent < jobIndent) {
      assert.fail(`estrutura de jobs não enumerável na linha ${index + 1}`);
    }
    if (indent === jobIndent) {
      const header = line.match(/^\s*([A-Za-z0-9_-]+):\s*$/);
      assert.ok(header, `job inválido ou não enumerável na linha ${index + 1}`);
      current = { name: header[1], lines: [] };
      result.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  assert.ok(result.length > 0, "o workflow precisa declarar ao menos um job");
  return result;
}

// Um passo começa em qualquer item de lista sob `steps:`, não apenas em `- name:`,
// porque `name` é opcional e um passo pode abrir direto com `- uses:` ou `- run:`.
function steps(jobLines) {
  const stepsLine = jobLines.findIndex((line) => /^\s*steps:\s*$/.test(line));
  if (stepsLine < 0) return [];
  const firstItem = jobLines.findIndex((line, index) => index > stepsLine && /^\s*-\s+\S/.test(line));
  if (firstItem < 0) return [];
  const itemIndent = indentOf(jobLines[firstItem]);
  const boundaries = [];
  for (let index = firstItem; index < jobLines.length; index += 1) {
    const line = jobLines[index];
    if (!line.trim()) continue;
    if (indentOf(line) < itemIndent) break;
    if (indentOf(line) === itemIndent && /^\s*-\s+\S/.test(line)) boundaries.push(index);
  }
  return boundaries.map((start, position) => {
    const end = position + 1 < boundaries.length ? boundaries[position + 1] : jobLines.length;
    return { index: position, lines: jobLines.slice(start, end) };
  });
}

function stepKeyIndent(step) {
  return effectiveIndent(step.lines[0], true);
}

// Só as chaves de nível superior do passo. Evita confundir `env:`, `run:` ou
// qualquer bloco aninhado com as chaves da própria action.
function topLevelKey(step, position, name) {
  const line = step.lines[position];
  if (!line.trim()) return null;
  if (effectiveIndent(line, isFirstLine(position)) !== stepKeyIndent(step)) return null;
  const match = keyLine(line, isFirstLine(position)).match(new RegExp(`^\\s*${name}:\\s*(.*)$`));
  return match ? match[1] : null;
}

// Inputs de action são exclusivamente filhos diretos de `with:`.
function withParameters(step) {
  const keyIndent = stepKeyIndent(step);
  const parameters = {};
  let insideWith = false;
  for (let position = 0; position < step.lines.length; position += 1) {
    const line = step.lines[position];
    if (!line.trim()) continue;
    const first = isFirstLine(position);
    const indent = effectiveIndent(line, first);
    if (indent <= keyIndent) {
      insideWith = topLevelKey(step, position, "with") !== null;
      continue;
    }
    if (!insideWith) continue;
    if (indent !== keyIndent + 2) continue;
    const entry = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (entry) parameters[entry[1]] = entry[2];
  }
  return parameters;
}

function stepUses(step) {
  for (let position = 0; position < step.lines.length; position += 1) {
    const value = topLevelKey(step, position, "uses");
    if (value !== null) return value;
  }
  return "";
}

// Reconhece apenas a chave `run:` de nível superior do passo.
function runBody(step) {
  const keyIndent = stepKeyIndent(step);
  for (let position = 0; position < step.lines.length; position += 1) {
    const inline = topLevelKey(step, position, "run");
    if (inline === null) continue;
    const collected = /^[|>]/.test(inline) || !inline ? [] : [inline];
    for (let next = position + 1; next < step.lines.length; next += 1) {
      const line = step.lines[next];
      if (!line.trim()) continue;
      if (indentOf(line) <= keyIndent) break;
      collected.push(line);
    }
    return collected.join("\n");
  }
  return "";
}

function hasRunStep(step) {
  return step.lines.some((_, position) => topLevelKey(step, position, "run") !== null);
}

function analyzeWorkflowJobs(text = readWorkflow()) {
  return jobBlocks(text).map((job) => {
    const jobSteps = steps(job.lines);
    const checkouts = jobSteps
      .filter((step) => /actions\/checkout@/.test(stepUses(step)))
      .map((step) => {
        const parameters = withParameters(step);
        return { index: step.index, ref: parameters.ref ?? null, path: parameters.path ?? "" };
      });
    const setupNodes = jobSteps
      .filter((step) => /actions\/setup-node@/.test(stepUses(step)))
      .map((step) => {
        const parameters = withParameters(step);
        return {
          index: step.index,
          versionFile: parameters["node-version-file"] ?? null,
          version: parameters["node-version"] ?? null
        };
      });
    return {
      name: job.name,
      actions: jobSteps
        .map((step) => ({ index: step.index, uses: stepUses(step) }))
        .filter((action) => action.uses),
      checkouts,
      base: checkouts.filter((checkout) => checkout.ref === BASE_SHA_REF),
      candidate: checkouts.filter((checkout) => checkout.ref === HEAD_SHA_REF),
      setupNodes,
      runs: jobSteps.filter(hasRunStep).map((step) => step.index),
      runtime: jobSteps.filter((step) => usesNodeRuntime(runBody(step))).map((step) => step.index)
    };
  });
}

function setupViolations(job) {
  if (job.runs.length === 0 || job.setupNodes.length > 0) return [];
  return [`job ${job.name}: possui passo run, mas não declara setup-node confiável`];
}

// O checkout correspondente é aquele cujo `path` produz exatamente o
// `node-version-file` declarado: raiz gera `.nvmrc`, `trusted` gera `trusted/.nvmrc`.
function matchingBaseCheckout(job, setupNode) {
  return (
    job.base.find(
      (checkout) => (checkout.path ? `${checkout.path}/.nvmrc` : ".nvmrc") === setupNode.versionFile
    ) ?? null
  );
}

function checkoutCanOverwrite(checkout, versionFile) {
  if (!checkout.path) return true;
  const prefix = `${checkout.path.replace(/\/$/, "")}/`;
  return versionFile.startsWith(prefix);
}

function provenanceViolations(job) {
  const problems = [];
  for (const setupNode of job.setupNodes) {
    const baseCheckout = matchingBaseCheckout(job, setupNode);
    if (!baseCheckout || !setupNode.versionFile) continue;
    for (const checkout of job.checkouts) {
      if (checkout.index <= baseCheckout.index || checkout.index >= setupNode.index) continue;
      if (checkout.ref === BASE_SHA_REF) continue;
      if (!checkoutCanOverwrite(checkout, setupNode.versionFile)) continue;
      problems.push(
        `job ${job.name}: checkout não fixado em base.sha no passo ${checkout.index} pode sobrescrever ${setupNode.versionFile} antes do setup-node`
      );
    }
    for (const action of job.actions) {
      if (action.index <= baseCheckout.index || action.index >= setupNode.index) continue;
      if (/actions\/checkout@/.test(action.uses)) continue;
      problems.push(
        `job ${job.name}: action ${action.uses} no passo ${action.index} pode alterar ${setupNode.versionFile} antes do setup-node`
      );
    }
  }
  return problems;
}

function orderViolations(job) {
  const problems = [];
  if (job.runs.length === 0) return problems;
  const firstRuntime = Math.min(...job.runs);
  for (const setupNode of job.setupNodes) {
    const checkout = matchingBaseCheckout(job, setupNode);
    if (!checkout) {
      problems.push(
        `job ${job.name}: node-version-file ${setupNode.versionFile} não corresponde a nenhum checkout fixado em base.sha`
      );
      continue;
    }
    if (checkout.index >= setupNode.index) {
      problems.push(
        `job ${job.name}: checkout correspondente no passo ${checkout.index} precisa vir antes de setup-node no passo ${setupNode.index}`
      );
    }
    if (setupNode.index >= firstRuntime) {
      problems.push(
        `job ${job.name}: setup-node no passo ${setupNode.index} precisa vir antes do primeiro passo run no passo ${firstRuntime}`
      );
    }
  }
  return problems;
}

const CHECKOUT_SHA = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_SHA = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const EXPECTED_JOBS = ["claude-review", "governance", "quality"];

function jobSetViolations(jobs) {
  const observed = jobs.map((job) => job.name).sort();
  if (observed.length === EXPECTED_JOBS.length && observed.every((name, index) => name === EXPECTED_JOBS[index])) {
    return [];
  }
  return [
    `jobs esperados: ${EXPECTED_JOBS.join(", ")}; observados: ${observed.join(", ") || "nenhum"}`
  ];
}

test("`.nvmrc` e `engines.node` declaram exatamente a mesma versão", () => {
  const nvmrc = readFileSync(resolve(projectRoot, ".nvmrc"), "utf8").trim();
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
  assert.match(nvmrc, /^\d+\.\d+\.\d+$/, "`.nvmrc` precisa fixar major, minor e patch");
  assert.equal(
    manifest.engines?.node,
    nvmrc,
    "`engines.node` precisa ser idêntico a `.nvmrc`, sem faixa semântica"
  );
});

test("o workflow não fixa versão de Node literal em nenhum job", () => {
  const literals = readWorkflow()
    .split(/\r?\n/)
    .filter((line) => /^\s+node-version:\s*\S/.test(line));
  assert.deepEqual(
    literals,
    [],
    `versão literal de Node encontrada; use node-version-file: ${literals.join(" | ")}`
  );
});

test("todo job com passo run declara setup-node com node-version-file", () => {
  for (const job of analyzeWorkflowJobs()) {
    assert.deepEqual(setupViolations(job), [], `setup-node ausente no job ${job.name}`);
    if (job.runs.length === 0) continue;
    assert.ok(
      job.setupNodes.length > 0,
      `job ${job.name} executa node, npm, npx ou corepack sem passo setup-node; a versão viria do runner`
    );
    for (const setupNode of job.setupNodes) {
      assert.equal(setupNode.version, null, `job ${job.name} ainda usa node-version literal`);
      assert.ok(setupNode.versionFile, `job ${job.name} precisa declarar node-version-file`);
    }
  }
});

test("cada setup-node tem checkout de base correspondente, antes dele e antes do runtime", () => {
  for (const job of analyzeWorkflowJobs()) {
    assert.deepEqual(orderViolations(job), [], `ordem inválida no job ${job.name}`);
  }
});

test("node-version-file nunca vem de diretório controlado pelo candidato", () => {
  for (const job of analyzeWorkflowJobs()) {
    for (const setupNode of job.setupNodes) {
      if (!setupNode.versionFile) continue;
      for (const checkout of job.candidate) {
        assert.ok(
          !checkout.path || !setupNode.versionFile.startsWith(`${checkout.path}/`),
          `job ${job.name}: node-version-file ${setupNode.versionFile} vem do checkout candidato ${checkout.path}`
        );
      }
      assert.ok(
        !/^(candidate|pr-head)\//.test(setupNode.versionFile),
        `job ${job.name}: node-version-file ${setupNode.versionFile} usa diretório reservado ao candidato`
      );
    }
  }
});

test("o workflow enumera exatamente os jobs de governança esperados", () => {
  assert.deepEqual(jobSetViolations(analyzeWorkflowJobs()), []);
});

test("nenhum checkout intermediário pode substituir a origem confiável do node-version-file", () => {
  for (const job of analyzeWorkflowJobs()) {
    assert.deepEqual(provenanceViolations(job), [], `proveniência inválida no job ${job.name}`);
  }
});

test("quando o node-version-file está na raiz, o checkout da raiz é fixado em base.sha", () => {
  for (const job of analyzeWorkflowJobs()) {
    if (!job.setupNodes.some((setupNode) => setupNode.versionFile === ".nvmrc")) continue;
    const rootCheckouts = job.checkouts.filter((checkout) => checkout.path === "");
    assert.equal(
      rootCheckouts.length,
      1,
      `job ${job.name} usa .nvmrc da raiz e precisa de exatamente um checkout na raiz`
    );
    assert.equal(
      rootCheckouts[0].ref,
      BASE_SHA_REF,
      `job ${job.name}: o checkout da raiz precisa estar fixado em base.sha antes de fornecer .nvmrc`
    );
  }
});

test("evidência negativa: node-version-file declarado em env: não é input da action", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  fake-env:
    steps:
      - name: Checkout trusted base
        uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: trusted
      - name: Use Node.js
        uses: ${SETUP_NODE_SHA}
        env:
          node-version-file: trusted/.nvmrc
        with:
          node-version: 24
      - name: Run governance
        run: node trusted/tooling/governance/validate-pr.mjs
`);
  assert.equal(job.setupNodes[0].versionFile, null, "chave em env: não pode virar input da action");
  assert.equal(job.setupNodes[0].version, "24", "o input real dentro de with: precisa ser lido");
  assert.deepEqual(orderViolations(job), [
    "job fake-env: node-version-file null não corresponde a nenhum checkout fixado em base.sha"
  ]);
});

test("evidência negativa: checkout de base irrelevante antes do setup não satisfaz a ordem", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  wrong-order:
    steps:
      - name: Checkout unrelated base
        uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: other
      - name: Use Node.js
        uses: ${SETUP_NODE_SHA}
        with:
          node-version-file: trusted/.nvmrc
      - name: Checkout trusted base
        uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: trusted
      - name: Run governance
        run: node trusted/tooling/governance/validate-pr.mjs
`);
  assert.equal(job.base.length, 2, "os dois checkouts de base precisam ser reconhecidos");
  assert.equal(matchingBaseCheckout(job, job.setupNodes[0]).index, 2, "o correspondente é o de trusted");
  assert.deepEqual(orderViolations(job), [
    "job wrong-order: checkout correspondente no passo 2 precisa vir antes de setup-node no passo 1"
  ]);
});

test("o detector reconhece runtime apenas em posição de comando", () => {
  const fixtures = [
    { body: "echo npm indisponível", runtime: false, why: "menção em argumento não é execução" },
    { body: "# executar node depois", runtime: false, why: "comentário não é execução" },
    { body: "echo pronto && npm test", runtime: true, why: "após && está em posição de comando" },
    { body: "node script.mjs", runtime: true, why: "início da linha é posição de comando" },
    { body: "  npm ci", runtime: true, why: "espaços à esquerda não descaracterizam o início" },
    { body: "echo a | npx cowsay", runtime: true, why: "após | está em posição de comando" },
    { body: "echo a; corepack enable", runtime: true, why: "após ; está em posição de comando" },
    { body: "git log --grep node", runtime: false, why: "argumento de outro comando não é execução" },
    { body: "echo primeiro\nnode segundo.mjs", runtime: true, why: "qualquer linha do corpo basta" },
    { body: "echo 'sem node aqui' # node", runtime: false, why: "comentário ao fim da linha é removido" }
  ];
  for (const fixture of fixtures) {
    assert.equal(
      usesNodeRuntime(fixture.body),
      fixture.runtime,
      `${JSON.stringify(fixture.body)}: ${fixture.why}`
    );
  }
});

test("evidência negativa: run: aninhado não conta como comando de runtime", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  nested-run:
    steps:
      - name: Checkout trusted base
        uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: trusted
      - name: Not a runtime step
        uses: some/action@0000000000000000000000000000000000000000
        with:
          script: |
            run: node fake.mjs
`);
  assert.deepEqual(job.runtime, [], "chave run: aninhada não pode ser lida como comando do passo");
  assert.deepEqual(orderViolations(job), [], "sem runtime, não há ordem a exigir");
});

test("enumeração vazia de jobs reprova explicitamente", () => {
  assert.throws(
    () => analyzeWorkflowJobs("jobs:\n"),
    /o workflow precisa declarar ao menos um job/,
    "ausência de jobs não pode equivaler a aprovação"
  );
});

test("jobs com indentação YAML válida diferente continuam sendo enumerados", () => {
  const jobs = analyzeWorkflowJobs(`jobs:
    indented-job:
        steps:
            - run: echo sem runtime
`);
  assert.deepEqual(jobs.map((job) => job.name), ["indented-job"]);
});

test("qualquer passo run exige setup-node, inclusive invocação indireta", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  indirect-runtime:
    steps:
      - run: env NODE_OPTIONS=--no-warnings node script.mjs
`);
  assert.deepEqual(setupViolations(job), [
    "job indirect-runtime: possui passo run, mas não declara setup-node confiável"
  ]);
});

test("nenhum passo run pode sobrescrever a nvmrc confiável antes do setup-node", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  runtime-file-overwrite:
    steps:
      - uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: trusted
      - uses: ${CHECKOUT_SHA}
        with:
          ref: ${HEAD_SHA_REF}
          path: candidate
      - run: cp candidate/.nvmrc trusted/.nvmrc
      - uses: ${SETUP_NODE_SHA}
        with:
          node-version-file: trusted/.nvmrc
      - run: node trusted/tooling/governance/validate-pr.mjs
`);
  assert.deepEqual(orderViolations(job), [
    "job runtime-file-overwrite: setup-node no passo 3 precisa vir antes do primeiro passo run no passo 2"
  ]);
});

test("CI reprova quando o caminho do workflow candidato não é informado", () => {
  assert.throws(
    () => workflowPath({ CI: "true" }, projectRoot),
    /CI precisa informar RUNTIME_PARITY_WORKFLOW/,
    "o teste confiável não pode validar o próprio workflow por omissão"
  );
});

test("CI rejeita caminho que aponta para o workflow confiável em vez do candidato", () => {
  assert.throws(
    () =>
      workflowPath(
        { CI: "true", RUNTIME_PARITY_WORKFLOW: "trusted/.github/workflows/pr-gates.yml" },
        projectRoot
      ),
    /RUNTIME_PARITY_WORKFLOW precisa ser candidate\/\.github\/workflows\/pr-gates\.yml/
  );
});

test("o job de qualidade seleciona explicitamente o workflow candidato", () => {
  const candidatePath = "candidate/.github/workflows/pr-gates.yml";
  assert.equal(
    workflowPath({ CI: "true", RUNTIME_PARITY_WORKFLOW: candidatePath }, projectRoot),
    resolve(projectRoot, candidatePath)
  );
  assert.match(
    readWorkflow(),
    /^\s+RUNTIME_PARITY_WORKFLOW:\s+candidate\/\.github\/workflows\/pr-gates\.yml\s*$/m,
    "o teste confiável precisa receber o caminho do workflow candidato"
  );
});

test("dependências candidatas são instaladas sem scripts de ciclo de vida", () => {
  const installCommands = readWorkflow()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^run:\s+npm ci(?:\s|$)/.test(line));
  assert.deepEqual(installCommands, ["run: npm ci --ignore-scripts"]);
});

test("checkout não confiável não pode sobrescrever a origem da nvmrc antes do setup-node", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  checkout-overwrite:
    steps:
      - uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: trusted
      - uses: ${CHECKOUT_SHA}
        with:
          path: trusted
      - uses: ${SETUP_NODE_SHA}
        with:
          node-version-file: trusted/.nvmrc
      - run: node trusted/tooling/governance/validate-pr.mjs
`);
  assert.deepEqual(provenanceViolations(job), [
    "job checkout-overwrite: checkout não fixado em base.sha no passo 1 pode sobrescrever trusted/.nvmrc antes do setup-node"
  ]);
});

test("action executável não pode rodar entre o checkout confiável e o setup-node", () => {
  const [job] = analyzeWorkflowJobs(`jobs:
  action-overwrite:
    steps:
      - uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
          path: trusted
      - uses: ./candidate/overwrite-runtime
      - uses: ${SETUP_NODE_SHA}
        with:
          node-version-file: trusted/.nvmrc
      - run: node trusted/tooling/governance/validate-pr.mjs
`);
  assert.deepEqual(provenanceViolations(job), [
    "job action-overwrite: action ./candidate/overwrite-runtime no passo 1 pode alterar trusted/.nvmrc antes do setup-node"
  ]);
});

test("conjunto parcial de jobs reprova em vez de validar parcialmente", () => {
  const jobs = analyzeWorkflowJobs(`jobs:
  governance:
    steps:
      - uses: ${CHECKOUT_SHA}
        with:
          ref: ${BASE_SHA_REF}
      - uses: ${SETUP_NODE_SHA}
        with:
          node-version-file: .nvmrc
      - run: node trusted/tooling/governance/validate-pr.mjs
`);
  assert.deepEqual(jobSetViolations(jobs), [
    "jobs esperados: claude-review, governance, quality; observados: governance"
  ]);
});
