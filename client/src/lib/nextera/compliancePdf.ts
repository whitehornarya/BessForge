// Client-side PDF export of the compliance report (jsPDF + autotable).
// Letter landscape, ECI-branded header, summary block, then the findings
// table grouped by checklist category.
import { finalizePdfBlob } from './pdfIdentity';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from '../saveFile';
import { ComplianceReport, ComplianceFinding } from './complianceReport';

const STATUS_COLORS: Record<ComplianceFinding['status'], [number, number, number]> = {
  PASS: [22, 130, 66],
  WARN: [180, 120, 10],
  FAIL: [180, 40, 40],
};

export function buildCompliancePdf(report: ComplianceReport): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const p = report.project;
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('BESS Compliance Report', margin, 48);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90);
  doc.text('NextEra Site Plan Guidance R2 (5-14-2026) — Attachment 2A checklist', margin, 62);
  doc.setTextColor(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('ECI', pageW - margin, 48, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(90);
  doc.text(`Generated ${report.generatedAt}`, pageW - margin, 60, { align: 'right' });
  doc.setTextColor(0);

  // Project summary block
  const summaryRows = [
    ['Project', p.projectName || '—', 'Location', p.location || '—'],
    ['Configuration', p.configLabel, 'Climate', p.hotClimate ? 'Hot (>40°C) — 14 ft PCS clearance' : 'Standard (<40°C) — 10 ft PCS clearance'],
    ['Achieved rating', `${p.achievedMW.toFixed(1)} MW / ${p.achievedMWh.toFixed(0)} MWh`, 'Target rating', `${p.targetMW} MW / ${p.targetMWh} MWh`],
    ['Blocks placed', `${p.blocksPlaced} of ${p.blocksRequired}`, 'Result',
      `${report.passCount} PASS / ${report.warnCount} WARN / ${report.failCount} FAIL`],
    ['Drawn by', p.drafter || '—', 'Rev / Date', `${p.revision} / ${p.date || '—'}`],
  ];
  // Multi-area sites: name every area and its own result on the summary block,
  // and state plainly when an area could not be checked — a clean overall
  // count must never read as a pass while an area is missing its layout.
  // Also disclose access-road capacity shortfalls so a reviewer skimming the
  // summary block sees the shortfall without having to read the findings table.
  if (report.site) {
    const s = report.site;
    summaryRows.push([
      'Site areas',
      `${s.areaCount} areas — ${s.perArea.map(a => `${a.areaName}: ${a.passCount}P/${a.warnCount}W/${a.failCount}F`).join('; ')}`,
      'Not checked',
      s.uncheckedAreas.length ? `INCOMPLETE — ${s.uncheckedAreas.join('; ')} (no layout generated)` : 'none — every area checked',
    ]);
    for (const sf of s.capacityShortfalls) {
      summaryRows.push([
        'Road capacity shortfall',
        `${sf.name}: requested ${sf.requestedMW.toFixed(1)} MW / ${sf.requestedMWh.toFixed(0)} MWh`,
        'Achieved',
        `${sf.achievedMW.toFixed(1)} MW / ${sf.achievedMWh.toFixed(0)} MWh — recommend increasing the phase footprint or reducing the target`,
      ]);
    }
  }
  autoTable(doc, {
    startY: 74,
    body: summaryRows,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 3 },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 90, fillColor: [240, 243, 246] },
      1: { cellWidth: 266 },
      2: { fontStyle: 'bold', cellWidth: 90, fillColor: [240, 243, 246] },
      3: { cellWidth: 266 },
    },
    margin: { left: margin, right: margin },
  });

  // Findings grouped by category. A multi-area report gains a leading Area
  // column so a finding is never ambiguous about which yard it came from;
  // single-area output keeps the original five columns exactly.
  const multiArea = !!report.site;
  let y = (doc as any).lastAutoTable.finalY + 14;
  const categories = Array.from(new Set(report.findings.map(f => f.category)));
  for (const cat of categories) {
    const rows = report.findings.filter(f => f.category === cat);
    autoTable(doc, {
      startY: y,
      head: [[{ content: cat, colSpan: multiArea ? 6 : 5, styles: { fillColor: [30, 41, 59], fontSize: 9 } }],
        multiArea
          ? ['Area', 'Rule', 'Status', 'Required', 'Measured', 'Entities']
          : ['Rule', 'Status', 'Required', 'Measured', 'Entities']],
      body: rows.map(f => {
        const cells = [
          `${f.checklistItem}\n${f.rule}`,
          f.status,
          f.required,
          f.measured,
          f.entityIds.join(', ') || '—',
        ];
        return multiArea ? [f.areaName ?? '—', ...cells] : cells;
      }),
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 3, valign: 'top' },
      headStyles: { fillColor: [51, 65, 85], fontSize: 7.5 },
      columnStyles: multiArea
        ? {
            0: { cellWidth: 78, fontStyle: 'bold' },
            1: { cellWidth: 180 },
            2: { cellWidth: 42, halign: 'center', fontStyle: 'bold' },
            3: { cellWidth: 118 },
            4: { cellWidth: 180 },
            5: { cellWidth: 114 },
          }
        : {
            0: { cellWidth: 210 },
            1: { cellWidth: 42, halign: 'center', fontStyle: 'bold' },
            2: { cellWidth: 130 },
            3: { cellWidth: 210 },
            4: { cellWidth: 120 },
          },
      didParseCell: data => {
        if (data.section === 'body' && data.column.index === (multiArea ? 2 : 1)) {
          const s = String(data.cell.raw) as ComplianceFinding['status'];
          if (STATUS_COLORS[s]) data.cell.styles.textColor = STATUS_COLORS[s];
        }
      },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 10;
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(
      'Diagrammatic 10% design — layouts convey concepts only; the Engineer of Record owns detailed design. BESSForge / ECI.',
      margin, doc.internal.pageSize.getHeight() - 20
    );
    doc.text(`Page ${i} of ${pages}`, pageW - margin, doc.internal.pageSize.getHeight() - 20, { align: 'right' });
    doc.setTextColor(0);
  }
  return doc;
}

export function exportCompliancePdf(report: ComplianceReport, fileName: string): Promise<boolean> {
  // jsPDF's doc.save() is an anchor download, which is a no-op inside the
  // Tauri WebView — route through saveBlob for a native dialog there.
  // Resolves false when the user cancels the native save dialog.
  return saveBlob(finalizePdfBlob(buildCompliancePdf(report)), fileName);
}
