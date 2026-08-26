// Web worker entry: runs layout generation, DXF building and the optimizer
// search off the main thread. Protocol: every request carries a client `seq`;
// responses echo it so the client can drop superseded results. Optimizer runs
// stream `progress` messages and honor `cancel` messages between evaluations
// (the generator yields after every candidate, and we drain the message queue
// via a microtask-free flag set by onmessage — cancel arrives because the
// optimizer loop below chunks work with await).
import {
  DesignWorkerRequest,
  handleGenerate,
  handleDxf,
  handleDxfPackage,
  OptimizeRequest,
  ScenariosRequest,
  GradingRequest,
  FeederRoutingRequest,
} from './designWorkerCore';
import { getConfiguration } from './catalog';
import { optimizeSteps } from './optimizer';
import { scenarioSteps } from './scenarios';
import { gradingSteps } from './gradingOptimizer';
import { optimizeFeederRoutingSteps } from './feederOptimizer';

interface Envelope {
  seq: number;
  req?: DesignWorkerRequest;
  cancel?: boolean;
}

const cancelled = new Set<number>();

async function runOptimize(seq: number, req: OptimizeRequest) {
  const it = optimizeSteps(
    req.boundary,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.baseOptions,
    req.seed
  );
  let r = it.next();
  while (!r.done) {
    postMessage({ seq, progress: { done: r.value.done, total: r.value.total } });
    if (cancelled.has(seq)) {
      it.return?.(undefined as any);
      cancelled.delete(seq);
      postMessage({
        seq,
        result: {
          candidates: [],
          allCandidates: [],
          evaluated: r.value.done,
          total: r.value.total,
          cancelled: true,
          seed: req.seed,
          baselineBlocks: 0,
        },
      });
      return;
    }
    // Yield to the worker event loop so cancel messages can be processed.
    await new Promise<void>(res => setTimeout(res, 0));
    r = it.next();
  }
  cancelled.delete(seq);
  // Drop the full accepted pool — the optimizer UI only shows the top
  // candidates, so ~40 designs never need to cross postMessage.
  postMessage({ seq, result: { ...r.value, allCandidates: [] } });
}

// Scenario comparison: same seeded search, same streaming progress/cancel
// protocol; the response is the compact per-objective scenario picks.
async function runScenarios(seq: number, req: ScenariosRequest) {
  const it = scenarioSteps(
    req.boundary,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.baseOptions,
    req.seed
  );
  let r = it.next();
  while (!r.done) {
    postMessage({ seq, progress: { done: r.value.done, total: r.value.total } });
    if (cancelled.has(seq)) {
      it.return?.(undefined as any);
      cancelled.delete(seq);
      postMessage({
        seq,
        result: {
          scenarios: [],
          evaluated: r.value.done,
          total: r.value.total,
          cancelled: true,
          seed: req.seed,
          baselineBlocks: 0,
        },
      });
      return;
    }
    await new Promise<void>(res => setTimeout(res, 0));
    r = it.next();
  }
  cancelled.delete(seq);
  postMessage({ seq, result: r.value });
}

// Grading rotation sweep: same streaming progress/cancel protocol as the
// optimizer — the generator yields after every candidate layout run.
async function runGrading(seq: number, req: GradingRequest) {
  const it = gradingSteps(
    req.boundary,
    req.grid,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.options,
    req.objective,
    req.stepDeg
  );
  let r = it.next();
  while (!r.done) {
    postMessage({ seq, progress: { done: r.value.done, total: r.value.total } });
    if (cancelled.has(seq)) {
      it.return?.(undefined as any);
      cancelled.delete(seq);
      postMessage({
        seq,
        result: {
          candidates: [],
          baselineBlocks: 0,
          objective: req.objective,
          stepDeg: req.stepDeg ?? 5,
          evaluated: r.value.done,
          total: r.value.total,
          cancelled: true,
        },
      });
      return;
    }
    await new Promise<void>(res => setTimeout(res, 0));
    r = it.next();
  }
  cancelled.delete(seq);
  postMessage({ seq, result: r.value });
}

// Feeder-routing search: same streaming progress/cancel protocol. Cheap per
// candidate for the mode sweep, then a few slow aux-trench verifications at
// the end — the awaited yield between steps is what keeps Cancel responsive
// through those.
async function runFeederRouting(seq: number, req: FeederRoutingRequest) {
  const it = optimizeFeederRoutingSteps(
    req.design,
    req.substation,
    req.blockMW,
    req.base,
    req.current
  );
  let r = it.next();
  while (!r.done) {
    postMessage({ seq, progress: { done: r.value.done, total: r.value.total } });
    if (cancelled.has(seq)) {
      it.return?.(undefined as any);
      cancelled.delete(seq);
      postMessage({
        seq,
        result: {
          candidates: [],
          current: null,
          evaluated: r.value.done,
          total: r.value.total,
          cancelled: true,
        },
      });
      return;
    }
    await new Promise<void>(res => setTimeout(res, 0));
    r = it.next();
  }
  cancelled.delete(seq);
  postMessage({ seq, result: r.value });
}

onmessage = (e: MessageEvent<Envelope>) => {
  const { seq, req, cancel } = e.data;
  if (cancel) {
    cancelled.add(seq);
    return;
  }
  if (!req) return;
  try {
    if (req.kind === 'generate') {
      postMessage({ seq, result: handleGenerate(req) });
    } else if (req.kind === 'dxf') {
      postMessage({ seq, result: handleDxf(req) });
    } else if (req.kind === 'dxfPackage') {
      postMessage({ seq, result: handleDxfPackage(req) });
    } else if (req.kind === 'optimize') {
      void runOptimize(seq, req);
    } else if (req.kind === 'scenarios') {
      void runScenarios(seq, req);
    } else if (req.kind === 'grading') {
      void runGrading(seq, req);
    } else if (req.kind === 'feederRouting') {
      void runFeederRouting(seq, req);
    }
  } catch (err: any) {
    postMessage({ seq, error: err?.message || 'Worker computation failed' });
  }
};
