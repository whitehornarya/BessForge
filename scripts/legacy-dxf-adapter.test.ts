/**
 * Legacy DXF adapter + routing tests.
 * Run: npx tsx --tsconfig scripts/tsconfig.test.json scripts/legacy-dxf-adapter.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LEGACY_TEMPLATE_CONTRACT,
  tryBuildLegacyTemplateArtifact,
  validateLegacyLayoutInput,
} from '@bessforge/legacy-dxf';
import { adaptSiteDesignToLegacyLayoutInput } from '../client/src/lib/nextera/legacyDxfAdapter';
import {
  buildLegacyLayoutExport,
  LegacyExportValidationError,
} from '../client/src/lib/nextera/legacyDxfExport';
import type { SiteDesign } from '../client/src/lib/nextera/types';
import type { TitleBlockInfo } from '../client/src/lib/stores/useDesignStore';
import type { FeederCircuit } from '../client/src/lib/nextera/feeders';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const titleBlock: TitleBlockInfo = {
  projectName: 'TEST BESS',
  location: 'TEST SITE',
  drafter: 'TEST',
  revision: '0A',
  date: '01/15/26',
  neerDwgName: '',
};

function sampleDesign(): SiteDesign {
  return {
    boundary: {
      name: 'Test Parcel',
      polygon: [
        { x: 0, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 300 },
        { x: 0, y: 300 },
      ],
      origin: { lat: 35, lon: -100 },
      areaAcres: 2.75,
    },
    fence: [
      { x: 10, y: 10 },
      { x: 390, y: 10 },
      { x: 390, y: 290 },
      { x: 10, y: 290 },
    ],
    equipment: [
      {
        id: 'con-1',
        kind: 'bess',
        label: 'CON1-A',
        x: 100,
        y: 200,
        rotation: Math.PI / 2,
        length: 28,
        width: 8,
        height: 10,
        epanel: 'left',
      },
      {
        id: 'pcs-1',
        kind: 'inverter',
        label: 'PCS1',
        x: 100,
        y: 160,
        rotation: 0,
        length: 24,
        width: 8,
        height: 10,
      },
    ],
    augmentationZones: [],
    reservedZones: [],
    reserveSummary: null,
    roads: [],
    aisles: [],
    roadNetwork: null,
    gate: null,
    cables: [
      {
        id: 'dc-1',
        class: 'DC',
        polarity: 'pos',
        pts: [
          { x: 100, y: 190 },
          { x: 100, y: 165 },
        ],
      },
      {
        id: 'dc-2',
        class: 'DC',
        polarity: 'neg',
        pts: [
          { x: 108, y: 190 },
          { x: 100, y: 165 },
        ],
      },
    ],
    trench: null,
    surfacing: null,
    blockRows: [],
    rowEditGeom: null,
    blocksPlaced: 1,
    blocksRequired: 1,
    achievedMW: 5,
    achievedMWh: 20,
    targetMW: 5,
    targetMWh: 20,
    warnings: [],
  };
}

function sampleFeeder(): FeederCircuit {
  return {
    idx: 1,
    name: '14A1',
    inverterIds: ['pcs-1'],
    loadMW: 5,
    amps: 100,
    segments: [
      {
        pts: [
          { x: 100, y: 160 },
          { x: 380, y: 160 },
          { x: 380, y: 150 },
        ],
        lengthFt: 290,
        amps: 100,
      },
    ],
    totalLengthFt: 290,
    size: '500kcmil',
    material: 'Cu',
    vdVolts: 10,
    vdPct: 1,
    overLimit: false,
    recommendedSize: null,
    ampacity: 300,
    fjbId: null,
    overAmpacity: false,
    ampacityRecommendedSize: null,
    parallelRunsNeeded: 1,
    futurePcs: 0,
    eolAmps: 100,
    parallelSets: 1,
    effectiveAmpacity: 300,
    adjacentCircuits: 1,
  } as FeederCircuit;
}

// --- adapter validates ---
{
  const input = adaptSiteDesignToLegacyLayoutInput({
    design: sampleDesign(),
    titleBlock,
    feeders: [sampleFeeder()],
    substation: { x: 380, y: 150 },
  });
  const result = validateLegacyLayoutInput(input);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues, null, 2));
  assert.ok(input.equipment.some(e => e.kind === 'bess' && e.configuration === 'A'));
  assert.ok(input.equipment.some(e => e.kind === 'substation'));
  assert.ok(input.cables.some(c => c.class === 'bess-feeder-14a1'));
  assert.ok(input.cables.some(c => c.class === 'dc-positive'));
  console.log('ok — adapter output validates');
}

// --- non-Legacy selection does not adapt ---
{
  let adapted = false;
  const routed = tryBuildLegacyTemplateArtifact('current', () => {
    adapted = true;
    throw new Error('adapter must not run');
  });
  assert.equal(routed.handled, false);
  assert.equal(adapted, false);
  console.log('ok — non-Legacy selection unhandled');
}

// --- Legacy selection builds page-2 artifact ---
{
  const routed = buildLegacyLayoutExport(
    LEGACY_TEMPLATE_CONTRACT.id,
    {
      design: sampleDesign(),
      titleBlock,
      feeders: [sampleFeeder()],
      substation: { x: 380, y: 150 },
    },
    { filename: 'Test_Legacy_Layout.dxf' },
  );
  assert.equal(routed.handled, true);
  if (!routed.handled) throw new Error('expected handled');
  assert.equal(routed.artifact.pageRole, LEGACY_TEMPLATE_CONTRACT.pageRole);
  assert.equal(routed.artifact.mimeType, 'application/dxf');
  assert.equal(routed.artifact.filename, 'Test_Legacy_Layout.dxf');
  assert.ok(routed.artifact.text.includes('SECTION'));
  assert.ok(routed.artifact.bytes.byteLength > 1000);
  console.log('ok — Legacy artifact pageRole + bytes');
}

// --- deterministic hash for equivalent snapshots ---
{
  const ctx = {
    design: sampleDesign(),
    titleBlock,
    feeders: [sampleFeeder()],
    substation: { x: 380, y: 150 },
  };
  const a = buildLegacyLayoutExport(LEGACY_TEMPLATE_CONTRACT.id, ctx);
  const b = buildLegacyLayoutExport(LEGACY_TEMPLATE_CONTRACT.id, ctx);
  assert.equal(a.handled && b.handled, true);
  if (!a.handled || !b.handled) throw new Error('expected handled');
  assert.equal(sha256(a.artifact.bytes), sha256(b.artifact.bytes));
  console.log('ok — repeated export SHA-256 stable');
}

// --- label is not the persisted selector ---
{
  assert.notEqual(LEGACY_TEMPLATE_CONTRACT.label, LEGACY_TEMPLATE_CONTRACT.id);
  const byLabel = tryBuildLegacyTemplateArtifact(LEGACY_TEMPLATE_CONTRACT.label, () => {
    throw new Error('must not adapt on label');
  });
  assert.equal(byLabel.handled, false);
  console.log('ok — routing uses stable id, not Legacy label');
}

// --- validation error surfaces paths ---
{
  let threw = false;
  try {
    buildLegacyLayoutExport(LEGACY_TEMPLATE_CONTRACT.id, {
      design: {
        ...sampleDesign(),
        boundary: {
          name: 'Bad',
          polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
          origin: { lat: 0, lon: 0 },
          areaAcres: 0,
        },
        fence: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      },
      titleBlock,
    });
  } catch (e) {
    threw = true;
    assert.ok(e instanceof LegacyExportValidationError);
    assert.ok((e as LegacyExportValidationError).issues.length > 0);
    assert.ok((e as LegacyExportValidationError).issues.some(i => i.path.length > 0));
  }
  assert.equal(threw, true);
  console.log('ok — validation issues surfaced');
}

console.log('\nAll legacy-dxf adapter tests passed.');
