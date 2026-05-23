// Argus orchestration graph (LangGraph).
//
// Replaces the legacy launch-pipeline fan-out of fire-and-forget `fetch()`
// calls with an explicit StateGraph: shared typed state, parallel branches,
// conditional gating and per-node retries.
//
//   START ─┬─→ provenance ─→ publish ─┬─→ alert ─(photo?)─→ visionSearch ─┐
//          │                          └─→ video ─→ END                    │
//          ├─→ atlas ──────→ END                          ┌───────────────┘
//          ├─→ intel ──────→ END                          ▼
//          ├─→ osintSocial ─→ END                      sentinel ─→ anchor ─→ END
//          └─→ pulse ──────→ END
//
// Key improvements over the old route:
//   • Provenance gate: a `suspect` portrait never reaches public publish.
//   • Sentinel runs AFTER vision search (real edge, not a setTimeout hack).
//   • Every network node retries; failures land in state.errors, not the void.

import { StateGraph, START, END } from '@langchain/langgraph';
import { CaseState, type CaseStateType } from './state';
import {
  provenanceNode,
  atlasNode,
  intelNode,
  osintSocialNode,
  pulseNode,
  publishNode,
  alertNode,
  videoNode,
  visionSearchNode,
  sentinelNode,
  anchorNode,
} from './nodes';

const retry = { retryPolicy: { maxAttempts: 2 } };

const builder = new StateGraph(CaseState)
  .addNode('provenanceGate', provenanceNode, retry)
  .addNode('atlas', atlasNode, retry)
  .addNode('intel', intelNode, retry)
  .addNode('osintSocial', osintSocialNode, retry)
  .addNode('pulse', pulseNode, retry)
  .addNode('publish', publishNode, retry)
  .addNode('alert', alertNode, retry)
  .addNode('video', videoNode, retry)
  .addNode('visionSearch', visionSearchNode, retry)
  .addNode('sentinel', sentinelNode, retry)
  .addNode('anchor', anchorNode, retry)

  // Fan-out from START: discovery + context branches run in parallel.
  .addEdge(START, 'provenanceGate')
  .addEdge(START, 'atlas')
  .addEdge(START, 'intel')
  .addEdge(START, 'osintSocial')
  .addEdge(START, 'pulse')

  // Side-effect branches terminate on their own.
  .addEdge('atlas', END)
  .addEdge('intel', END)
  .addEdge('osintSocial', END)
  .addEdge('pulse', END)

  // Main publish chain — gated by the provenance verdict.
  .addEdge('provenanceGate', 'publish')
  .addEdge('publish', 'alert')
  .addEdge('publish', 'video')
  .addEdge('video', END)

  // Conditional: only sweep candidate photos when a portrait exists.
  .addConditionalEdges(
    'alert',
    (state: CaseStateType) => (state.photoUrl ? 'withPhoto' : 'noPhoto'),
    { withPhoto: 'visionSearch', noPhoto: 'sentinel' },
  )
  .addEdge('visionSearch', 'sentinel')
  .addEdge('sentinel', 'anchor')
  .addEdge('anchor', END);

export const argusGraph = builder.compile();

export interface PipelineInput {
  caseId: string;
  description: Record<string, any>;
  photoUrl?: string | null;
  authorityEmail?: string | null;
  origin: string;
  bannerUrl: string;
  geo: CaseStateType['geo'];
}

/** Run the full orchestration to completion and return the accumulated state. */
export async function runArgusPipeline(input: PipelineInput): Promise<CaseStateType> {
  return (await argusGraph.invoke({
    caseId: input.caseId,
    description: input.description || {},
    photoUrl: input.photoUrl ?? null,
    authorityEmail: input.authorityEmail ?? null,
    origin: input.origin,
    bannerUrl: input.bannerUrl,
    geo: input.geo,
  })) as CaseStateType;
}
