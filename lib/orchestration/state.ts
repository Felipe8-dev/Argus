// Shared state for the Argus orchestration graph.
//
// This is the single source of truth that flows between nodes. Where the
// legacy launch-pipeline fanned out fire-and-forget `fetch()` calls with no
// shared context, every LangGraph node now reads and writes this typed state.

import { Annotation } from '@langchain/langgraph';
import type { GeoResult } from './geocode';

export interface ProvenanceVerdict {
  verdict: 'verified' | 'suspect' | 'unknown';
  score?: number;
}

/**
 * Reducer that shallow-merges partial result objects so parallel nodes can
 * each contribute their slice (`{ publish: ... }`, `{ search: ... }`) without
 * clobbering each other.
 */
const mergeResults = (a: Record<string, any>, b: Record<string, any>) => ({ ...a, ...b });
const concat = <T>(a: T[], b: T[]) => a.concat(b);

export const CaseState = Annotation.Root({
  // --- inputs (set once at START) ---
  caseId: Annotation<string>(),
  description: Annotation<Record<string, any>>({
    reducer: (_a, b) => b,
    default: () => ({}),
  }),
  photoUrl: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  authorityEmail: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  origin: Annotation<string>(),
  bannerUrl: Annotation<string>(),

  // --- derived ---
  geo: Annotation<GeoResult | null>({ reducer: (_a, b) => b ?? _a, default: () => null }),
  provenance: Annotation<ProvenanceVerdict | null>({
    reducer: (_a, b) => b ?? _a,
    default: () => null,
  }),

  // --- accumulated outputs (merged across parallel branches) ---
  results: Annotation<Record<string, any>>({ reducer: mergeResults, default: () => ({}) }),
  errors: Annotation<string[]>({ reducer: concat, default: () => [] }),
});

export type CaseStateType = typeof CaseState.State;
export type CaseUpdate = Partial<CaseStateType>;
