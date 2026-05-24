// Pipeline trace test — runs the REAL LangGraph orchestration with fake case
// data and prints, in order, which nodes executed.
//
// It does NOT mock the graph: it imports the real `argusGraph` compiled in
// lib/orchestration/graph.ts and drives it with `.stream({ streamMode: 'updates' })`.
// Only the network layer is stubbed — `globalThis.fetch` returns canned JSON for
// each internal `/api/*` endpoint — so the graph runs end to end without a server.
//
// Run:  npx tsx tests/pipeline-trace.mts
//   or: npm run test:pipeline

/* ----------------------------- fetch stub ------------------------------ */
// Records every internal call and returns a canned response per endpoint.
// `provenanceVerdict` is read live so each scenario can flip the gate.

let provenanceVerdict: 'verified' | 'suspect' | 'unknown' = 'verified';
const httpCalls: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  httpCalls.push(path);

  let payload: any = { ok: true, mock: true, path };
  if (path.startsWith('/api/intel/provenance')) {
    payload = { verdict: provenanceVerdict, score: 0.92 };
  } else if (path.startsWith('/api/agents/sentinel')) {
    payload = { ok: true, patterns: [], clusters: 0 };
  } else if (path.startsWith('/api/search')) {
    payload = { ok: true, matches: 0 };
  }

  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as any;
}) as typeof fetch;

/* --------------------------- load the graph ---------------------------- */

const graphModule: any = await import('../lib/orchestration/graph.ts');
const argusGraph = graphModule.argusGraph ?? graphModule.default?.argusGraph ?? graphModule.default;

if (!argusGraph || typeof argusGraph.stream !== 'function') {
  console.error('No pude cargar argusGraph desde lib/orchestration/graph.ts');
  process.exit(1);
}

/* ------------------------------ scenarios ------------------------------ */

interface Scenario {
  title: string;
  verdict: 'verified' | 'suspect' | 'unknown';
  withPhoto: boolean;
}

const baseGeo = { gps_lat: 9.241, gps_lon: -74.755, place_label: 'Magangué, Bolívar, Colombia' };

function buildInput(s: Scenario) {
  return {
    caseId: 'TEST-CASE-001',
    description: { nombre: 'Juan Pérez', ultima_ubicacion: 'barrio Pastrana, Magangué', edad: '14', genero: 'M' },
    photoUrl: s.withPhoto ? 'https://example.test/portrait.jpg' : null,
    authorityEmail: 'autoridad@test.local',
    origin: 'http://localhost:9999',
    bannerUrl: 'http://localhost:9999/api/banner/TEST-CASE-001',
    geo: baseGeo,
  };
}

const scenarios: Scenario[] = [
  { title: 'Caso CON foto, provenance = verified (camino completo)', verdict: 'verified', withPhoto: true },
  { title: 'Caso CON foto, provenance = suspect (publicación bloqueada)', verdict: 'suspect', withPhoto: true },
  { title: 'Caso SIN foto (la búsqueda por visión se omite)', verdict: 'unknown', withPhoto: false },
];

async function runScenario(s: Scenario, index: number) {
  provenanceVerdict = s.verdict;
  httpCalls.length = 0;

  console.log('\n========================================================================');
  console.log(`ESCENARIO ${index + 1}: ${s.title}`);
  console.log('========================================================================');

  const order: string[] = [];
  let step = 0;

  // streamMode 'updates' emits one chunk per node as it finishes, in execution order.
  const stream = await argusGraph.stream(buildInput(s), { streamMode: 'updates' });
  for await (const chunk of stream) {
    for (const nodeName of Object.keys(chunk)) {
      step += 1;
      order.push(nodeName);
      const update = chunk[nodeName] ?? {};
      let note = '';
      if (nodeName === 'provenanceGate') note = `  → verdict=${update?.provenance?.verdict}`;
      if (nodeName === 'publish') {
        const pub = update?.results?.publish;
        note = pub?.skipped ? `  → BLOQUEADO (${pub.reason})` : '  → publicado';
      }
      console.log(`  [${String(step).padStart(2, '0')}] ${nodeName}${note}`);
    }
  }

  console.log('------------------------------------------------------------------------');
  console.log('Orden final :', order.join(' → '));
  console.log('visionSearch ejecutado? ', order.includes('visionSearch') ? 'SÍ' : 'NO (omitido por el edge condicional)');
  console.log('Endpoints /api llamados:', httpCalls.length);
  console.log('  ', httpCalls.join('  '));
}

/* -------------------------------- main --------------------------------- */

(async () => {
  console.log('Argus · trazado de orquestación LangGraph (grafo REAL, red simulada)');
  const g = argusGraph.getGraph();
  console.log('Nodos del grafo compilado:', Object.keys(g.nodes).filter((n) => !n.startsWith('__')).join(', '));

  for (let i = 0; i < scenarios.length; i++) {
    await runScenario(scenarios[i], i);
  }

  console.log('\n✔ Trazado completo. El grafo se ejecutó de extremo a extremo en cada escenario.');
  globalThis.fetch = realFetch;
})();
