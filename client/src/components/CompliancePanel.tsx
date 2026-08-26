// One-click compliance report panel: scores the current design against every
// row of the NextEra guidance checklist, groups findings by sheet/category,
// click-to-highlight offending equipment in the preview, and exports the
// report as PDF or CSV.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { getEffectiveConfiguration } from '../lib/nextera/catalog';
import {
  buildComplianceReport,
  buildSiteComplianceReport,
  complianceReportToCsv,
  ComplianceFinding,
} from '../lib/nextera/complianceReport';
import { areaFeederEndpoint } from '../lib/nextera/substationTakeoffs';
import { exportCompliancePdf } from '../lib/nextera/compliancePdf';
import { saveBlob } from '../lib/saveFile';

const STATUS_STYLE: Record<ComplianceFinding['status'], { icon: string; cls: string }> = {
  PASS: { icon: '✓', cls: 'text-emerald-400' },
  WARN: { icon: '⚠', cls: 'text-amber-400' },
  FAIL: { icon: '✕', cls: 'text-red-400' },
};

export default function CompliancePanel() {
  const design = useDesignStore(s => s.design);
  const configId = useDesignStore(s => s.configId);
  const hotClimate = useDesignStore(s => s.hotClimate);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const titleBlock = useDesignStore(s => s.titleBlock);
  const feeders = useDesignStore(s => s.feeders);
  // Multi-area: every BESS yard's own routed feeders, keyed by area id. The
  // active area's live `feeders` still win for it (they carry in-flight
  // edits); the rest are scored against their OWN routes instead of being
  // skipped, which used to hide feeder findings in inactive areas.
  const areaFeeders = useDesignStore(s => s.areaFeeders);
  const substation = useDesignStore(s => s.substation);
  // The active area's resolved landing point (its take-off on a multi-area
  // site), which carries in-flight edits the stored areas do not.
  const feederEndpoint = useDesignStore(s => s.feederEndpoint);
  const areaZones = useDesignStore(s => s.areaZones);
  const siteAreas = useDesignStore(s => s.siteAreas);
  const activeAreaId = useDesignStore(s => s.activeAreaId);
  const highlightIds = useDesignStore(s => s.highlightIds);
  const setHighlightIds = useDesignStore(s => s.setHighlightIds);
  const setActiveArea = useDesignStore(s => s.setActiveArea);

  const [open, setOpen] = useState(false);
  const [activeRule, setActiveRule] = useState<string | null>(null);

  // A multi-area site is scored area by area and merged, so a finding always
  // names the yard it came from. Single-area projects keep the exact original
  // single-design call (byte-identical report, CSV and PDF).
  const multiArea = siteAreas.length > 1;
  const report = useMemo(() => {
    if (!design || !open) return null;
    const config = getEffectiveConfiguration(configId, containersPerPcs);
    if (multiArea) {
      return buildSiteComplianceReport(
        siteAreas.map(a => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          // The active area's live design carries the drafter's in-flight
          // edits; stored area designs are the regenerated ones.
          design: a.id === activeAreaId ? design : a.design,
          // Every input is the AREA'S OWN. Each area routes its feeders to
          // the substation take-off aimed at it, so each is scored against
          // its own routes; borrowing the active area's would score a yard
          // against trenches it does not contain.
          feeders: a.id === activeAreaId ? feeders : areaFeeders[a.id],
          // A BESS yard's routes land on its take-off in the SUBSTATION area,
          // so it has no local substation. Passing the legacy field here gave
          // every routed BESS area a null endpoint, which drops its MV feeder
          // finding from the report entirely.
          substation: areaFeederEndpoint(a, siteAreas, {
            activeAreaId, liveEndpoint: feederEndpoint,
          }),
          areaZones: a.id === activeAreaId ? areaZones : (a.edits?.areaZones ?? null),
        })),
        config,
        // No top-level areaZones: they belong to the active area only and are
        // passed per-area above.
        { hotClimate, titleBlock }
      );
    }
    return buildComplianceReport(design, config, {
      hotClimate, titleBlock, feeders, substation, areaZones,
    });
    // areaFeeders/feederEndpoint are real inputs: without them an open report
    // goes stale the moment another area's routes change.
  }, [design, configId, containersPerPcs, hotClimate, titleBlock, feeders, substation,
      areaZones, open, multiArea, siteAreas, activeAreaId, areaFeeders, feederEndpoint]);

  if (!design) return null;

  const fileBase = (titleBlock.projectName?.trim() || design.boundary.name || 'bessforge')
    .replace(/[^a-z0-9-_ ]/gi, '')
    .replace(/\s+/g, '-')
    .toLowerCase();

  const pickFinding = (f: ComplianceFinding) => {
    if (activeRule === f.ruleId) {
      setActiveRule(null);
      setHighlightIds([]);
      return;
    }
    setActiveRule(f.ruleId);
    // Entity ids (bess-1-1, inv-2, ...) are only unique WITHIN an area — every
    // area's design numbers its equipment from scratch. Highlighting an
    // inactive area's finding against the active scene would therefore mark
    // the same-numbered equipment in the wrong yard, so switch to the
    // finding's own area first and let the scene re-render there.
    const needsSwitch = !!f.areaId && f.areaId !== activeAreaId;
    if (needsSwitch) setActiveArea(f.areaId!);
    setHighlightIds(f.entityIds);
    if (f.entityIds.length) {
      toast.info(
        needsSwitch
          ? `Switched to ${f.areaName} — ${f.entityIds.length} item(s) highlighted`
          : `${f.entityIds.length} item(s) highlighted in the preview`
      );
    } else if (needsSwitch) {
      toast.info(`Switched to ${f.areaName}`);
    }
  };

  const categories = report ? Array.from(new Set(report.findings.map(f => f.category))) : [];

  return (
    <section className="bg-slate-800 rounded p-3">
      <button
        onClick={() => {
          setOpen(v => !v);
          if (open) { setActiveRule(null); setHighlightIds([]); }
        }}
        className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400"
      >
        <span>Compliance Report — NextEra R2</span>
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && report && (
        <div className="mt-2 space-y-2">
          <div className="text-xs">
            <span className="text-emerald-400 font-semibold">{report.passCount} pass</span>
            <span className="text-slate-500"> · </span>
            <span className="text-amber-400 font-semibold">{report.warnCount} warn</span>
            <span className="text-slate-500"> · </span>
            <span className="text-red-400 font-semibold">{report.failCount} fail</span>
            <span className="text-slate-500"> — {report.findings.length} rules checked</span>
            {report.site && (
              <span className="text-slate-500"> across {report.site.areaCount} areas</span>
            )}
          </div>

          {/* Per-area result line, plus a loud note when an area could not be
              checked — an all-clear count must never look like a site pass
              while a yard is missing its layout. */}
          {report.site && (
            <div className="text-[10px] space-y-0.5 bg-slate-900/60 rounded p-1.5">
              {report.site.perArea.map(a => (
                <div key={a.areaId} className="flex justify-between gap-2">
                  <span className="text-slate-300 truncate">{a.areaName}</span>
                  <span className="shrink-0 font-mono">
                    <span className="text-emerald-400">{a.passCount}</span>
                    <span className="text-slate-600">/</span>
                    <span className="text-amber-400">{a.warnCount}</span>
                    <span className="text-slate-600">/</span>
                    <span className="text-red-400">{a.failCount}</span>
                  </span>
                </div>
              ))}
              {report.site.uncheckedAreas.length > 0 && (
                <div className="text-amber-400 pt-1">
                  ⚠ Incomplete — not checked (no layout generated):{' '}
                  {report.site.uncheckedAreas.join(', ')}
                </div>
              )}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {categories.map(cat => {
              const rows = report.findings.filter(f => f.category === cat);
              const worst = rows.some(f => f.status === 'FAIL') ? 'FAIL' : rows.some(f => f.status === 'WARN') ? 'WARN' : 'PASS';
              return (
                <div key={cat}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-0.5 flex items-center gap-1.5">
                    <span className={STATUS_STYLE[worst].cls}>{STATUS_STYLE[worst].icon}</span>
                    {cat}
                  </div>
                  <div className="space-y-0.5">
                    {rows.map(f => (
                      <button
                        key={f.ruleId}
                        onClick={() => pickFinding(f)}
                        title={`${f.rule}\nRequired: ${f.required}\nMeasured: ${f.measured}${f.entityIds.length ? `\nEntities: ${f.entityIds.join(', ')}` : ''}`}
                        className={`w-full text-left text-xs flex gap-1.5 rounded px-1 py-0.5 transition-colors ${
                          activeRule === f.ruleId ? 'bg-pink-950/50 ring-1 ring-pink-600' : 'hover:bg-slate-700/60'
                        }`}
                      >
                        <span className={`shrink-0 ${STATUS_STYLE[f.status].cls}`}>{STATUS_STYLE[f.status].icon}</span>
                        {f.areaName && (
                          <span className="shrink-0 text-[10px] text-cyan-400/80">{f.areaName}</span>
                        )}
                        <span className="text-slate-300 truncate">{f.checklistItem}</span>
                        {f.status !== 'PASS' && (
                          <span className="text-slate-500 truncate">— {f.measured}</span>
                        )}
                        {f.entityIds.length > 0 && (
                          <span className="ml-auto shrink-0 text-[10px] text-pink-400" title="Click to highlight in the preview">
                            ◎ {f.entityIds.length}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {highlightIds.length > 0 && (
            <button
              onClick={() => { setActiveRule(null); setHighlightIds([]); }}
              className="w-full py-1 rounded bg-slate-700 hover:bg-slate-600 text-[11px] font-semibold text-slate-200"
            >
              Clear preview highlight
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={async () => {
                try {
                  const saved = await exportCompliancePdf(report, `${fileBase}-compliance-report.pdf`);
                  if (saved) toast.success('Compliance report PDF downloaded');
                } catch (err) {
                  toast.error(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }}
              className="py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 text-xs font-semibold text-slate-100"
            >
              Export PDF
            </button>
            <button
              onClick={() => {
                const csv = complianceReportToCsv(report);
                void saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${fileBase}-compliance-findings.csv`)
                  .then(saved => { if (saved) toast.success('Compliance findings CSV downloaded'); })
                  .catch(err => toast.error(`CSV export failed: ${err instanceof Error ? err.message : String(err)}`));
              }}
              className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
            >
              Export CSV
            </button>
          </div>
          <div className="text-[10px] text-slate-500">
            Click a finding with ◎ to highlight the affected equipment in the preview. Rules map 1:1 to the NextEra Site Plan Guidance R2 checklist.
          </div>
        </div>
      )}
    </section>
  );
}
