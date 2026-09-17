import { CABLE_LAYER, DEFAULT_CALIBRATION_PROFILE, LAYERS, PAGE_HEIGHT_IN, PAGE_MARGIN_IN, PAGE_WIDTH_IN, STANDARD_SCALES_FT_PER_IN, TRENCH_LAYER, } from './constants.js';
import { CRL_SUBSTATION_PATHS, } from './crlSubstationTrace.js';
import { ECI_LOGO_ASPECT, ECI_LOGO_POLYS } from './eciLogoVector.js';
import { NORTH_ARROW_ASPECT, NORTH_ARROW_POLYS } from './northArrowVector.js';
import { normalizeRotationDeg, quantizeDxfNumber, quantizeDxfPoint, quantizedPointKey, } from './numeric.js';
import { DxfWriter, } from './writer.js';
import { CAR_D_B005_1_SOURCE_PROFILE, } from './sourceCalibration.js';
const legacyLayerDefinitions = [
    { name: LAYERS.FRAME, color: 7, lineType: 'CONTINUOUS', lineWeight: 35 },
    { name: LAYERS.TITLE, color: 7, lineType: 'CONTINUOUS', lineWeight: 25 },
    { name: LAYERS.TEXT_SM, color: 7, lineType: 'CONTINUOUS', lineWeight: -3 },
    { name: LAYERS.TEXT_MD, color: 7, lineType: 'CONTINUOUS', lineWeight: -3 },
    { name: LAYERS.TEXT_LG, color: 7, lineType: 'CONTINUOUS', lineWeight: 25 },
    { name: LAYERS.FENCE, color: 8, lineType: 'CONTINUOUS', lineWeight: 18 },
    { name: LAYERS.FENCE_ADJACENT, color: 8, lineType: 'DASHDOT', lineWeight: 18 },
    { name: LAYERS.FENCE_PROJECT, color: 8, lineType: 'DASHED2', lineWeight: 18 },
    { name: LAYERS.PROPERTY, color: 6, lineType: 'DASHED', lineWeight: 18 },
    { name: LAYERS.EQUIPMENT, color: 7, lineType: 'CONTINUOUS', lineWeight: 18 },
    { name: LAYERS.EQUIPMENT_LABEL, color: 7, lineType: 'CONTINUOUS', lineWeight: -3 },
    { name: LAYERS.FUTURE, color: 8, lineType: 'CONTINUOUS', lineWeight: 13 },
    { name: LAYERS.FUTURE_INVERTER, color: 30, lineType: 'CONTINUOUS', lineWeight: 13 },
    { name: LAYERS.EXCLUSION, color: 8, lineType: 'DASHED', lineWeight: 13 },
    { name: LAYERS.LAYDOWN, color: 9, lineType: 'DOT', lineWeight: 13 },
    { name: LAYERS.ROAD, color: 8, lineType: 'CONTINUOUS', lineWeight: 13 },
    { name: LAYERS.ROAD_HATCH, color: 9, lineType: 'CONTINUOUS', lineWeight: -3 },
    { name: LAYERS.ROAD_EXISTING, color: 8, lineType: 'DASHED', lineWeight: 13 },
    { name: LAYERS.SURFACING, color: 9, lineType: 'CONTINUOUS', lineWeight: -3 },
    { name: LAYERS.TRENCH_MVAC, color: 8, lineType: 'DASHED', lineWeight: 13 },
    { name: LAYERS.TRENCH_DC, color: 8, lineType: 'DASHED2', lineWeight: 13 },
    { name: LAYERS.TRENCH_AUX, color: 8, lineType: 'DASHDOT', lineWeight: 13 },
    { name: LAYERS.MATCH, color: 7, lineType: 'DASHED', lineWeight: 25 },
    { name: LAYERS.CALLOUT, color: 7, lineType: 'CONTINUOUS', lineWeight: 13 },
    { name: LAYERS.DETAIL, color: 7, lineType: 'CONTINUOUS', lineWeight: 18 },
    { name: LAYERS.FEEDER_14A1, color: 3, lineType: 'DASHED', lineWeight: 25 },
    { name: LAYERS.FEEDER_14A2, color: 5, lineType: 'CONTINUOUS', lineWeight: 25 },
    { name: LAYERS.FEEDER_14B1, color: 6, lineType: 'DASHDOT', lineWeight: 25 },
    { name: LAYERS.FEEDER_14B2, color: 210, lineType: 'CONTINUOUS', lineWeight: 25 },
    { name: LAYERS.FEEDER_15A1, color: 4, lineType: 'DASHED', lineWeight: 25 },
    { name: LAYERS.FEEDER_15A2, color: 160, lineType: 'CONTINUOUS', lineWeight: 25 },
    { name: LAYERS.FEEDER_15B1, color: 6, lineType: 'DASHED2', lineWeight: 25 },
    { name: LAYERS.FEEDER_15B2, color: 3, lineType: 'CONTINUOUS', lineWeight: 25 },
    { name: LAYERS.AUX_FEEDER, color: 30, lineType: 'DASHED', lineWeight: 18 },
    { name: LAYERS.DC_NEGATIVE, color: 5, lineType: 'CONTINUOUS', lineWeight: 18 },
    { name: LAYERS.DC_POSITIVE, color: 1, lineType: 'CONTINUOUS', lineWeight: 18 },
    { name: LAYERS.FIBER, color: 4, lineType: 'DASHDOT', lineWeight: 18 },
];
const legacyComposeProfile = Object.freeze({
    id: DEFAULT_CALIBRATION_PROFILE,
    layers: LAYERS,
    cableLayers: CABLE_LAYER,
    trenchLayers: TRENCH_LAYER,
    layerDefinitions: legacyLayerDefinitions,
    lineTypes: Object.freeze([]),
    textStyles: Object.freeze([]),
    textStyleByLayer: Object.freeze({}),
});
function resolveComposeProfile(options) {
    const profile = options.calibrationProfile ?? DEFAULT_CALIBRATION_PROFILE;
    if (profile === CAR_D_B005_1_SOURCE_PROFILE.id) {
        return {
            ...CAR_D_B005_1_SOURCE_PROFILE,
            paperPlanBoxIn: CAR_D_B005_1_SOURCE_PROFILE.facts.mainPlanViewport.paperPlanBoxIn,
            legendColumnIn: CAR_D_B005_1_SOURCE_PROFILE.facts.legendColumnIn,
        };
    }
    if (profile === DEFAULT_CALIBRATION_PROFILE)
        return legacyComposeProfile;
    throw new Error('options.calibrationProfile must be one of: legacy-v1, car-d-b005-1');
}
function canonical(rows) {
    return [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function allPlanPoints(input) {
    const out = [...input.siteBoundary.points, ...input.fence.points];
    const polygons = [...input.roads, ...input.existingAccess, ...input.surfacing, ...input.reservedZones];
    polygons.forEach(p => {
        out.push(...p.points);
        p.holes?.forEach(h => out.push(...h));
    });
    input.equipment.forEach(e => {
        const radius = Math.hypot(e.length, e.width) / 2;
        out.push({ x: e.center.x - radius, y: e.center.y - radius }, { x: e.center.x + radius, y: e.center.y + radius });
    });
    [...input.adjacentFences, ...input.projectFences, ...input.cables, ...input.trenches, ...input.matchLines].forEach(p => out.push(...p.points));
    input.callouts.forEach(c => out.push(c.anchor, c.elbow, c.textPoint));
    input.detailMarkers.forEach(d => out.push(d.center));
    return out;
}
function signedArea(points) {
    return points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p.x * q.y - q.x * p.y;
    }, 0) / 2;
}
function canonicalRing(points, ccw) {
    let ring = points.map(quantizeDxfPoint);
    if ((signedArea(ring) > 0) !== ccw)
        ring.reverse();
    let first = 0;
    for (let i = 1; i < ring.length; i++) {
        const a = ring[i], b = ring[first];
        if (a.x < b.x || (a.x === b.x && a.y < b.y))
            first = i;
    }
    return [...ring.slice(first), ...ring.slice(0, first)];
}
function ringSortKey(points) {
    return points.map(quantizedPointKey).join(';');
}
function pathMidpoint(points) {
    const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
    const half = lengths.reduce((a, b) => a + b, 0) / 2;
    let walked = 0;
    for (let i = 0; i < lengths.length; i++) {
        const length = lengths[i];
        if (walked + length >= half) {
            const t = length === 0 ? 0 : (half - walked) / length;
            return {
                x: points[i].x + (points[i + 1].x - points[i].x) * t,
                y: points[i].y + (points[i + 1].y - points[i].y) * t,
            };
        }
        walked += length;
    }
    return points[points.length - 1];
}
function drawTrace(writer, polygons, x, y, width, height, layer) {
    polygons.forEach(poly => writer.addHatch(poly.map(ring => ring.map(point => ({
        x: x + point[0] * width, y: y + point[1] * height,
    }))), layer, 'SOLID', 7));
}
function bounds(points) {
    return points.reduce((b, p) => ({
        minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y),
        maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}
function chooseSheet(input, options) {
    const profile = resolveComposeProfile(options);
    const requested = options.scaleFtPerIn ?? input.scale.preferredFtPerIn;
    const auto = options.autoScale ?? input.scale.autoScale;
    const start = STANDARD_SCALES_FT_PER_IN.indexOf(requested);
    if (start < 0)
        throw new Error(`scaleFtPerIn must be one of STANDARD_SCALES_FT_PER_IN; received ${requested}`);
    const source = bounds(allPlanPoints(input).map(quantizeDxfPoint));
    for (let i = start; i < STANDARD_SCALES_FT_PER_IN.length; i++) {
        const scale = STANDARD_SCALES_FT_PER_IN[i];
        const width = PAGE_WIDTH_IN * scale;
        const height = PAGE_HEIGHT_IN * scale;
        const margin = PAGE_MARGIN_IN * scale;
        const titleH = 1.65 * scale;
        const legendW = profile.legendColumnIn
            ? (profile.legendColumnIn.right - profile.legendColumnIn.left) * scale
            : 5.15 * scale;
        const plan = profile.paperPlanBoxIn
            ? {
                minX: profile.paperPlanBoxIn.left * scale,
                minY: profile.paperPlanBoxIn.bottom * scale,
                maxX: profile.paperPlanBoxIn.right * scale,
                maxY: profile.paperPlanBoxIn.top * scale,
            }
            : {
                minX: margin + 0.35 * scale,
                minY: margin + titleH + 0.2 * scale,
                maxX: width - margin - legendW - 0.35 * scale,
                maxY: height - margin - 0.25 * scale,
            };
        const fits = source.maxX - source.minX <= plan.maxX - plan.minX &&
            source.maxY - source.minY <= plan.maxY - plan.minY;
        if (fits) {
            return {
                scale, width, height, margin, titleH, legendW, plan, profile,
                dx: quantizeDxfNumber((plan.minX + plan.maxX - source.minX - source.maxX) / 2),
                dy: quantizeDxfNumber((plan.minY + plan.maxY - source.minY - source.maxY) / 2),
            };
        }
        if (!auto)
            break;
    }
    throw new Error(`Plan extents do not fit ANSI-D at requested 1in=${requested}ft scale${auto ? ' or any larger standard scale' : ''}`);
}
function transform(sheet, point) {
    const source = quantizeDxfPoint(point);
    return quantizeDxfPoint({ x: source.x + sheet.dx, y: source.y + sheet.dy });
}
function rect(writer, x, y, w, h, layer) {
    writer.addPolyline([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], layer, true);
}
function fitText(writer, cx, y, h, value, maxW, layer, style) {
    const height = Math.min(h, maxW / Math.max(1, value.length * 0.7));
    writer.addCenteredText({ x: cx, y }, height, value, layer, 0, style);
}
function drawBorder(writer, sheet) {
    const { margin: m, width: w, height: h, scale: s } = sheet;
    const layers = sheet.profile.layers;
    rect(writer, m, m, w - 2 * m, h - 2 * m, layers.FRAME);
    rect(writer, m + 0.08 * s, m + 0.08 * s, w - 2 * (m + 0.08 * s), h - 2 * (m + 0.08 * s), layers.FRAME);
    const left = m, right = w - m, bottom = m, top = h - m;
    const columns = 8;
    for (let i = 0; i < columns; i++) {
        const x = left + (i + 0.5) * (right - left) / columns;
        writer.addCenteredText({ x, y: top + 0.12 * s }, 0.11 * s, String.fromCharCode(65 + i), layers.TEXT_SM);
        writer.addCenteredText({ x, y: bottom - 0.2 * s }, 0.11 * s, String.fromCharCode(65 + i), layers.TEXT_SM);
        if (i > 0) {
            const tick = left + i * (right - left) / columns;
            writer.addLine({ x: tick, y: top }, { x: tick, y: top + 0.22 * s }, layers.FRAME);
            writer.addLine({ x: tick, y: bottom }, { x: tick, y: bottom - 0.22 * s }, layers.FRAME);
        }
    }
    const rows = 6;
    for (let i = 0; i < rows; i++) {
        const y = bottom + (i + 0.5) * (top - bottom) / rows;
        writer.addCenteredText({ x: left - 0.18 * s, y }, 0.11 * s, String(rows - i), layers.TEXT_SM, 90);
        writer.addCenteredText({ x: right + 0.1 * s, y }, 0.11 * s, String(rows - i), layers.TEXT_SM, 90);
        if (i > 0) {
            const tick = bottom + i * (top - bottom) / rows;
            writer.addLine({ x: left, y: tick }, { x: left - 0.22 * s, y: tick }, layers.FRAME);
            writer.addLine({ x: right, y: tick }, { x: right + 0.22 * s, y: tick }, layers.FRAME);
        }
    }
}
function drawTitle(writer, input, sheet) {
    const s = sheet.scale, x = sheet.margin, y = sheet.margin;
    const layers = sheet.profile.layers;
    const w = sheet.width - 2 * sheet.margin, h = sheet.titleH;
    rect(writer, x, y, w, h, layers.TITLE);
    const logoW = 5.1 * s, issueW = 7.25 * s, ownerW = 7.9 * s, engW = 4.15 * s;
    const x1 = x + logoW, x2 = x1 + issueW, x3 = x2 + ownerW, x4 = x3 + engW;
    [x1, x2, x3, x4].forEach(xx => writer.addLine({ x: xx, y }, { x: xx, y: y + h }, layers.TITLE));
    const logoH = 1.25 * s, logoWActual = logoH * ECI_LOGO_ASPECT;
    drawTrace(writer, ECI_LOGO_POLYS, x + (logoW - logoWActual) / 2, y + 0.2 * s, logoWActual, logoH, layers.TITLE);
    const revisions = [...input.title.revisions].sort((a, b) => a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0);
    const rowH = h / 4;
    const revisionCols = [x1 + 0.48 * s, x1 + 4.85 * s, x1 + 5.95 * s, x1 + 6.6 * s];
    revisionCols.forEach(xx => writer.addLine({ x: xx, y }, { x: xx, y: y + h }, layers.TITLE));
    for (let i = 1; i <= 3; i++)
        writer.addLine({ x: x1, y: y + i * rowH }, { x: x2, y: y + i * rowH }, layers.TITLE);
    ['REV', 'ISSUE HISTORY', 'DATE', 'BY', 'CHK'].forEach((label, i) => {
        const edges = [x1, ...revisionCols, x2];
        writer.addCenteredText({ x: (edges[i] + edges[i + 1]) / 2, y: y + h - 0.22 * s }, 0.09 * s, label, layers.TEXT_SM);
    });
    revisions.forEach((row, i) => {
        const yy = y + h - (i + 1.7) * rowH;
        writer.addText({ x: x1 + 0.12 * s, y: yy }, 0.1 * s, row.revision, layers.TEXT_SM);
        writer.addText({ x: x1 + 0.6 * s, y: yy }, 0.1 * s, row.description, layers.TEXT_SM);
        writer.addText({ x: revisionCols[1] + 0.08 * s, y: yy }, 0.085 * s, row.date, layers.TEXT_SM);
        writer.addText({ x: revisionCols[2] + 0.08 * s, y: yy }, 0.085 * s, row.by, layers.TEXT_SM);
        writer.addText({ x: revisionCols[3] + 0.08 * s, y: yy }, 0.085 * s, row.checkedBy, layers.TEXT_SM);
    });
    fitText(writer, (x2 + x3) / 2, y + 0.83 * s, 0.38 * s, input.title.projectOwner, ownerW - 0.2 * s, layers.TEXT_LG);
    fitText(writer, (x2 + x3) / 2, y + 0.36 * s, 0.16 * s, input.title.location, ownerW - 0.2 * s, layers.TEXT_MD);
    const eng = input.title.engineering;
    const engRows = [
        ['DRAWN', eng.drawnBy, eng.drawnDate], ['DESIGNED', eng.designedBy, eng.designedDate],
        ['CHECKED', eng.checkedBy, eng.checkedDate], ['APPROVED', eng.approvedBy, eng.approvedDate],
    ];
    engRows.forEach((row, i) => {
        const yy = y + h - (i + 0.72) * h / 4;
        if (i)
            writer.addLine({ x: x3, y: y + h - i * h / 4 }, { x: x4, y: y + h - i * h / 4 }, layers.TITLE);
        writer.addText({ x: x3 + 0.08 * s, y: yy }, 0.09 * s, row[0], layers.TEXT_SM);
        writer.addText({ x: x3 + 1.05 * s, y: yy }, 0.09 * s, row[1], layers.TEXT_SM);
        writer.addText({ x: x4 - 1.0 * s, y: yy }, 0.09 * s, row[2], layers.TEXT_SM);
    });
    fitText(writer, (x4 + x + w) / 2, y + 1.24 * s, 0.22 * s, input.title.projectName, x + w - x4 - 0.2 * s, layers.TEXT_MD);
    fitText(writer, (x4 + x + w) / 2, y + 0.94 * s, 0.18 * s, `${input.rating.mw} MW / ${input.rating.mwh} MWH BATTERY SYSTEM`, x + w - x4 - 0.2 * s, layers.TEXT_MD);
    fitText(writer, (x4 + x + w) / 2, y + 0.66 * s, 0.17 * s, input.title.sheetTitle, x + w - x4 - 0.2 * s, layers.TEXT_MD);
    fitText(writer, (x4 + x + w) / 2, y + 0.38 * s, 0.11 * s, `DWG: ${input.title.drawingNumber}   CLIENT: ${input.title.clientDrawingNumber || 'N/A'}`, x + w - x4 - 0.2 * s, layers.TEXT_SM);
    writer.addCenteredText({ x: x + w - 0.55 * s, y: y + 0.1 * s }, 0.1 * s, `REV ${input.title.revision}`, layers.TEXT_SM);
}
function drawNorthAndScale(writer, sheet, panelX, panelTop) {
    const s = sheet.scale, cx = panelX + sheet.legendW / 2;
    const layers = sheet.profile.layers;
    const top = panelTop;
    const arrowH = 2.7 * s, arrowW = arrowH * NORTH_ARROW_ASPECT;
    drawTrace(writer, NORTH_ARROW_POLYS, cx - arrowW / 2, top - 2.85 * s, arrowW, arrowH, layers.TITLE);
    writer.addCenteredText({ x: cx, y: top - 0.05 * s }, 0.2 * s, 'N', layers.TEXT_MD);
    const barY = top - 3.25 * s, unit = 0.5 * s, start = cx - 1.0 * s;
    for (let i = 0; i < 4; i++) {
        const box = [{ x: start + i * unit, y: barY }, { x: start + (i + 1) * unit, y: barY }, { x: start + (i + 1) * unit, y: barY + 0.16 * s }, { x: start + i * unit, y: barY + 0.16 * s }];
        if (i % 2 === 0)
            writer.addHatch([box], layers.TITLE, 'SOLID', 7);
        writer.addPolyline(box, layers.TITLE, true);
    }
    [['0', 0], [`${s / 2}FT`, 1], [`${s}FT`, 2], [`${2 * s}FT`, 4]].forEach(([label, index]) => writer.addCenteredText({ x: start + Number(index) * unit, y: barY + 0.28 * s }, 0.1 * s, String(label), layers.TEXT_SM));
    writer.addCenteredText({ x: cx, y: barY - 0.25 * s }, 0.13 * s, `SCALE: 1"=${sheet.scale}'`, layers.TEXT_SM);
}
const legendLabels = [
    ['bess-feeder-14a1', 'BESS FEEDER #14A1 (34.5 kV)'],
    ['bess-feeder-14a2', 'BESS FEEDER #14A2 (34.5 kV)'],
    ['bess-feeder-14b1', 'BESS FEEDER #14B1 (34.5 kV)'],
    ['bess-feeder-14b2', 'BESS FEEDER #14B2 (34.5 kV)'],
    ['bess-feeder-15a1', 'BESS FEEDER #15A1 (34.5 kV)'],
    ['bess-feeder-15a2', 'BESS FEEDER #15A2 (34.5 kV)'],
    ['bess-feeder-15b1', 'BESS FEEDER #15B1 (34.5 kV)'],
    ['bess-feeder-15b2', 'BESS FEEDER #15B2 (34.5 kV)'],
    ['aux-feeder', 'AUX FEEDER #15C1'],
    ['dc-negative', 'DC CABLE (-)'],
    ['dc-positive', 'DC CABLE (+)'],
    ['fiber', 'CATL FIBER NETWORK (6 COUNT)'],
];
function drawLegendGlyph(writer, glyph, x, cy, w, h, layer, useLegacyEntityColors = true) {
    const box = [
        { x, y: cy - h / 2 }, { x: x + w, y: cy - h / 2 },
        { x: x + w, y: cy + h / 2 }, { x, y: cy + h / 2 },
    ];
    const vertical = (fraction) => writer.addLine({ x: x + fraction * w, y: cy - h / 2 }, { x: x + fraction * w, y: cy + h / 2 }, layer);
    if (glyph === 'line') {
        writer.addLine({ x, y: cy }, { x: x + w, y: cy }, layer);
        return;
    }
    if (glyph === 'fence') {
        writer.addLine({ x, y: cy }, { x: x + w, y: cy }, layer);
        for (const fraction of [0.18, 0.5, 0.82]) {
            const cx = x + fraction * w, r = h * 0.38;
            writer.addLine({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r }, layer);
            writer.addLine({ x: cx - r, y: cy + r }, { x: cx + r, y: cy - r }, layer);
        }
        return;
    }
    if (glyph === 'detail') {
        const r = h * 0.72, cx = x + r;
        writer.addArc({ x: cx, y: cy }, r, 0, 180, layer);
        writer.addArc({ x: cx, y: cy }, r, 180, 360, layer);
        writer.addLine({ x: cx - r, y: cy }, { x: cx + r, y: cy }, layer);
        writer.addCenteredText({ x: cx, y: cy + r * 0.3 }, r * 0.42, 'X', layer);
        writer.addCenteredText({ x: cx, y: cy - r * 0.56 }, r * 0.25, 'B00X-Y', layer);
        writer.addText({ x: cx + r * 1.35, y: cy + r * 0.22 }, r * 0.22, 'INDICATES DETAIL X', layer);
        writer.addText({ x: cx + r * 1.35, y: cy - r * 0.48 }, r * 0.22, 'DRAWING ON WHICH DETAIL APPEARS B00X-X', layer);
        return;
    }
    if (glyph === 'exclusion')
        writer.addHatch([box], layer, 'ANSI37');
    if (glyph === 'proposed-access')
        writer.addHatch([box], layer, 'SOLID', useLegacyEntityColors ? 9 : undefined);
    if (glyph === 'existing-access')
        writer.addHatch([box], layer, 'SOLID', useLegacyEntityColors ? 8 : undefined);
    writer.addPolyline(box, layer, true);
    if (glyph === 'inverter') {
        vertical(0.5);
        writer.addLine({ x: x + 0.1 * w, y: cy - 0.3 * h }, { x: x + 0.4 * w, y: cy + 0.3 * h }, layer);
    }
    else if (glyph === 'bess-a' || glyph === 'bess-c') {
        vertical(0.25);
        vertical(0.5);
        vertical(0.75);
        const markerX = glyph === 'bess-a' ? x + 0.08 * w : x + 0.92 * w;
        writer.addLine({ x: markerX, y: cy - 0.3 * h }, { x: markerX, y: cy + 0.3 * h }, layer);
    }
    else if (glyph === 'aux-distribution') {
        vertical(0.33);
        vertical(0.67);
    }
    else if (glyph === 'aux-transformer') {
        const inset = box.map(point => ({
            x: x + w / 2 + (point.x - (x + w / 2)) * 0.55,
            y: cy + (point.y - cy) * 0.55,
        }));
        writer.addPolyline(inset, layer, true);
        writer.addLine(inset[0], inset[2], layer);
        writer.addLine(inset[1], inset[3], layer);
    }
    else if (glyph === 'fjb') {
        writer.addLine(box[0], box[2], layer);
        writer.addLine(box[1], box[3], layer);
        vertical(0.5);
    }
    else if (glyph === 'jb') {
        const inset = box.map(point => ({
            x: x + w / 2 + (point.x - (x + w / 2)) * 0.42,
            y: cy + (point.y - cy) * 0.55,
        }));
        writer.addPolyline(inset, layer, true);
    }
    else if (glyph === 'substation') {
        vertical(0.2);
        vertical(0.5);
        vertical(0.8);
        writer.addLine({ x: x + 0.08 * w, y: cy }, { x: x + 0.92 * w, y: cy }, layer);
    }
}
function drawLegend(writer, input, sheet) {
    const s = sheet.scale;
    const layers = sheet.profile.layers;
    const x = sheet.width - sheet.margin - sheet.legendW;
    const top = sheet.height - sheet.margin - 4.2 * s;
    const bottom = sheet.margin + sheet.titleH + 2.35 * s;
    const w = sheet.legendW;
    rect(writer, x, bottom, w, top - bottom, layers.TITLE);
    writer.addLine({ x, y: top - 0.48 * s }, { x: x + w, y: top - 0.48 * s }, layers.TITLE);
    writer.addCenteredText({ x: x + w / 2, y: top - 0.34 * s }, 0.25 * s, 'LEGEND', layers.TEXT_LG);
    const rows = [
        { label: 'PE FP4200M1 INVERTER', layer: layers.EQUIPMENT, glyph: 'inverter' },
        { label: "LG JF2 DC LINK 'A' CONFIG", layer: layers.EQUIPMENT, glyph: 'bess-a' },
        { label: "LG JF2 DC LINK 'C' CONFIG", layer: layers.EQUIPMENT, glyph: 'bess-c' },
        { label: 'AUX DISTRIBUTION CENTER', layer: layers.EQUIPMENT, glyph: 'aux-distribution' },
        { label: 'AUX TRANSFORMER', layer: layers.EQUIPMENT, glyph: 'aux-transformer' },
        { label: 'FIBER JUNCTION BOX', layer: layers.EQUIPMENT, glyph: 'fjb' },
        { label: 'JUNCTION BOX', layer: layers.EQUIPMENT, glyph: 'jb' },
        ...(input.equipment.some(eq => eq.kind === 'substation') ? [{
                label: 'EXISTING SUBSTATION',
                layer: sheet.profile.sourceSubstation?.layers.equipment ?? layers.EQUIPMENT,
                glyph: 'substation',
            }] : []),
        { label: 'FUTURE AUGMENTATION BATTERIES', layer: layers.FUTURE, glyph: 'future' },
        { label: 'FUTURE AUGMENTATION INVERTERS', layer: layers.FUTURE_INVERTER, glyph: 'future' },
        { label: 'UNDERGROUND EXCLUSION AREA', layer: layers.EXCLUSION, glyph: 'exclusion' },
        ...legendLabels.map(([klass, label]) => ({ label, layer: sheet.profile.cableLayers[klass], glyph: 'line' })),
        { label: 'ADJACENT SUBSTATION FENCE', layer: layers.FENCE_ADJACENT, glyph: 'fence' },
        { label: 'BESS FENCE', layer: layers.FENCE, glyph: 'fence' },
        { label: 'PROJECT FENCE (BY OTHERS)', layer: layers.FENCE_PROJECT, glyph: 'fence' },
        { label: 'PROPOSED EQUIPMENT ACCESS', layer: layers.ROAD, glyph: 'proposed-access' },
        { label: 'EXISTING ACCESS', layer: layers.ROAD_EXISTING, glyph: 'existing-access' },
        { label: '', layer: layers.DETAIL, glyph: 'detail' },
    ];
    const rowH = (top - bottom - 0.6 * s) / rows.length;
    rows.forEach((row, i) => {
        const cy = top - 0.62 * s - (i + 0.5) * rowH;
        const sx = x + 0.28 * s, sw = 1.35 * s;
        drawLegendGlyph(writer, row.glyph, sx, cy, sw, 0.26 * s, row.layer, sheet.profile.id === DEFAULT_CALIBRATION_PROFILE);
        if (row.label)
            writer.addText({ x: x + 1.85 * s, y: cy - 0.07 * s }, 0.095 * s, row.label, layers.TEXT_SM);
    });
    const stampY = sheet.margin + sheet.titleH;
    rect(writer, x, stampY, w, 0.78 * s, layers.TITLE);
    rect(writer, x + 0.08 * s, stampY + 0.08 * s, w - 0.16 * s, 0.62 * s, layers.TITLE);
    fitText(writer, x + w / 2, stampY + 0.28 * s, 0.26 * s, input.title.statusStamp, w - 0.25 * s, layers.TEXT_LG, sheet.profile.statusStampTextStyle);
    const notesY = stampY + 1.03 * s;
    const notesH = 1.25 * s;
    rect(writer, x, notesY, w, notesH, layers.TITLE);
    writer.addCenteredText({ x: x + w / 2, y: notesY + notesH - 0.27 * s }, 0.22 * s, 'NOTES', layers.TEXT_LG);
    input.title.notes.forEach((note, i) => fitText(writer, x + w / 2, notesY + notesH - (0.55 + i * 0.2) * s, 0.09 * s, `${i + 1}. ${note}`, w - 0.3 * s, layers.TEXT_SM));
    drawNorthAndScale(writer, sheet, x, sheet.height - sheet.margin - 0.2 * s);
}
function rotatedCorners(eq, center) {
    const rad = normalizeRotationDeg(eq.rotationDeg) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const hl = eq.length / 2, hw = eq.width / 2;
    return [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([x, y]) => ({
        x: center.x + x * c - y * s,
        y: center.y + x * s + y * c,
    }));
}
function drawSourceSubstation(writer, eq, center, layers) {
    const rotation = normalizeRotationDeg(eq.rotationDeg) * Math.PI / 180;
    const ux = Math.cos(rotation), uy = Math.sin(rotation);
    const vx = -uy, vy = ux;
    CRL_SUBSTATION_PATHS.forEach(path => writer.addPolyline(path.points.map(point => {
        const along = point.x * eq.length;
        const across = point.y * eq.width;
        return {
            x: center.x + ux * along + vx * across,
            y: center.y + uy * along + vy * across,
        };
    }), layers[path.layer], path.closed));
}
function drawEquipment(writer, eq, sheet) {
    const layers = sheet.profile.layers;
    const center = transform(sheet, eq.center);
    const corners = rotatedCorners(eq, center);
    const sourceSubstation = eq.kind === 'substation' ? sheet.profile.sourceSubstation : undefined;
    if (sourceSubstation)
        drawSourceSubstation(writer, eq, center, sourceSubstation.layers);
    else
        writer.addPolyline(corners, layers.EQUIPMENT, true);
    const rotation = normalizeRotationDeg(eq.rotationDeg);
    const rad = rotation * Math.PI / 180, ux = Math.cos(rad), uy = Math.sin(rad);
    const vx = -uy, vy = ux;
    const line = (along, halfWidth) => writer.addLine({ x: center.x + ux * along - vx * halfWidth, y: center.y + uy * along - vy * halfWidth }, { x: center.x + ux * along + vx * halfWidth, y: center.y + uy * along + vy * halfWidth }, layers.EQUIPMENT);
    const side = (across, halfLength) => writer.addLine({ x: center.x + vx * across - ux * halfLength, y: center.y + vy * across - uy * halfLength }, { x: center.x + vx * across + ux * halfLength, y: center.y + vy * across + uy * halfLength }, layers.EQUIPMENT);
    if (sourceSubstation) {
        // The source trace already contains the station's internal linework.
    }
    else if (eq.kind === 'bess') {
        [-0.3, 0, 0.3].forEach(f => line(f * eq.length, eq.width / 2));
        const marker = (eq.configuration === 'A' ? -0.42 : 0.42) * eq.length;
        line(marker, eq.width * 0.28);
    }
    else if (eq.kind === 'inverter') {
        line(0, eq.width / 2);
        writer.addLine({ x: center.x - ux * eq.length * 0.4 - vx * eq.width * 0.3, y: center.y - uy * eq.length * 0.4 - vy * eq.width * 0.3 }, { x: center.x - ux * eq.length * 0.1 + vx * eq.width * 0.3, y: center.y - uy * eq.length * 0.1 + vy * eq.width * 0.3 }, layers.EQUIPMENT);
    }
    else if (eq.kind === 'aux-distribution') {
        line(-eq.length / 6, eq.width / 2);
        line(eq.length / 6, eq.width / 2);
    }
    else if (eq.kind === 'aux-transformer') {
        const inset = corners.map(point => ({
            x: center.x + (point.x - center.x) * 0.58,
            y: center.y + (point.y - center.y) * 0.58,
        }));
        writer.addPolyline(inset, layers.EQUIPMENT, true);
        writer.addLine(inset[0], inset[2], layers.EQUIPMENT);
        writer.addLine(inset[1], inset[3], layers.EQUIPMENT);
    }
    else if (eq.kind === 'fiber-junction-box') {
        writer.addLine(corners[0], corners[2], layers.EQUIPMENT);
        writer.addLine(corners[1], corners[3], layers.EQUIPMENT);
        side(0, eq.length / 2);
    }
    else {
        const inset = corners.map(point => ({
            x: center.x + (point.x - center.x) * 0.45,
            y: center.y + (point.y - center.y) * 0.45,
        }));
        writer.addPolyline(inset, layers.EQUIPMENT, true);
    }
    const textH = Math.min(0.09 * sheet.scale, eq.width * 0.24, eq.length / Math.max(6, eq.label.length * 0.75));
    writer.addCenteredText(center, textH, eq.label, layers.EQUIPMENT_LABEL, rotation);
}
export function composeLegacyLayout(input, options = {}) {
    const sheet = chooseSheet(input, options);
    const { profile } = sheet;
    const { layers } = profile;
    const sourceSubstation = input.equipment.some(eq => eq.kind === 'substation')
        ? profile.sourceSubstation
        : undefined;
    const writer = new DxfWriter(sheet.scale / 20);
    profile.lineTypes.forEach(lineType => writer.addLineType(lineType));
    sourceSubstation?.lineTypes.forEach(lineType => writer.addLineType(lineType));
    profile.textStyles.forEach(style => writer.addTextStyle(style));
    profile.layerDefinitions.forEach(layer => writer.addLayer(layer));
    sourceSubstation?.layerDefinitions.forEach(layer => writer.addLayer(layer));
    Object.entries(profile.textStyleByLayer).forEach(([layer, style]) => writer.setLayerTextStyle(layer, style));
    drawBorder(writer, sheet);
    drawTitle(writer, input, sheet);
    drawLegend(writer, input, sheet);
    const tx = (points) => points.map(p => transform(sheet, p));
    const loops = (polygon) => [
        tx(canonicalRing(polygon.points, true)),
        ...(polygon.holes ?? [])
            .map(hole => canonicalRing(hole, false))
            .sort((a, b) => {
            const ak = ringSortKey(a), bk = ringSortKey(b);
            return ak < bk ? -1 : ak > bk ? 1 : 0;
        })
            .map(tx),
    ];
    const siteLoops = loops(input.siteBoundary);
    siteLoops.forEach(ring => writer.addPolyline(ring, layers.PROPERTY, true));
    loops(input.fence).forEach(ring => writer.addPolyline(ring, layers.FENCE, true));
    canonical(input.adjacentFences).forEach(fence => writer.addPolyline(tx(fence.points), layers.FENCE_ADJACENT));
    canonical(input.projectFences).forEach(fence => writer.addPolyline(tx(fence.points), layers.FENCE_PROJECT));
    canonical(input.surfacing).forEach(p => {
        const polygonLoops = loops(p);
        writer.addHatch(polygonLoops, layers.SURFACING, 'ANSI31', profile.id === DEFAULT_CALIBRATION_PROFILE ? 9 : undefined);
        writer.addPolyline(polygonLoops[0], layers.SURFACING, true);
    });
    canonical(input.roads).forEach(road => {
        const roadLoops = loops(road);
        writer.addHatch(roadLoops, layers.ROAD_HATCH, 'SOLID', profile.id === DEFAULT_CALIBRATION_PROFILE ? 9 : undefined);
        writer.addPolyline(roadLoops[0], layers.ROAD, true);
        if (road.label) {
            const b = bounds(roadLoops[0]);
            writer.addCenteredText({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, 0.09 * sheet.scale, road.label, layers.TEXT_SM);
        }
    });
    canonical(input.existingAccess).forEach(road => {
        const roadLoops = loops(road);
        writer.addHatch(roadLoops, layers.ROAD_EXISTING, 'SOLID', profile.id === DEFAULT_CALIBRATION_PROFILE ? 8 : undefined);
        roadLoops.forEach(ring => writer.addPolyline(ring, layers.ROAD_EXISTING, true));
        if (road.label) {
            const b = bounds(roadLoops[0]);
            writer.addCenteredText({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, 0.09 * sheet.scale, road.label, layers.TEXT_SM);
        }
    });
    canonical(input.reservedZones).forEach(zone => {
        const layer = zone.kind === 'future-augmentation-batteries' ? layers.FUTURE :
            zone.kind === 'future-augmentation-inverters' ? layers.FUTURE_INVERTER :
                zone.kind === 'laydown' ? layers.LAYDOWN : layers.EXCLUSION;
        const pattern = zone.kind.startsWith('future-augmentation') ? 'ANSI37' : 'ANSI31';
        const zoneLoops = loops(zone);
        writer.addHatch(zoneLoops, layer, pattern);
        writer.addPolyline(zoneLoops[0], layer, true);
        const b = bounds(zoneLoops[0]);
        writer.addCenteredText({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, 0.09 * sheet.scale, zone.label, layers.TEXT_SM);
    });
    canonical(input.trenches).forEach(run => writer.addPolyline(tx(run.points), profile.trenchLayers[run.class]));
    canonical(input.cables).forEach(run => {
        const points = tx(run.points);
        writer.addPolyline(points, profile.cableLayers[run.class]);
        if (run.feederName)
            writer.addCenteredText(pathMidpoint(points), 0.08 * sheet.scale, run.feederName, layers.TEXT_SM);
    });
    canonical(input.equipment).forEach(eq => drawEquipment(writer, eq, sheet));
    canonical(input.matchLines).forEach(line => {
        const pts = tx(line.points);
        writer.addPolyline(pts, layers.MATCH);
        const first = pts[0], last = pts[pts.length - 1];
        writer.addCenteredText({ x: (first.x + last.x) / 2 + 0.2 * sheet.scale, y: (first.y + last.y) / 2 }, 0.16 * sheet.scale, line.label, layers.TEXT_MD, 90);
    });
    canonical(input.callouts).forEach(callout => {
        const anchor = transform(sheet, callout.anchor), elbow = transform(sheet, callout.elbow), textPoint = transform(sheet, callout.textPoint);
        writer.addLine(anchor, elbow, layers.CALLOUT);
        writer.addLine(elbow, textPoint, layers.CALLOUT);
        writer.addText({ x: textPoint.x + 0.05 * sheet.scale, y: textPoint.y + 0.025 * sheet.scale }, 0.075 * sheet.scale, callout.text, layers.TEXT_SM);
    });
    canonical(input.detailMarkers).forEach(marker => {
        const center = transform(sheet, marker.center), r = 0.18 * sheet.scale;
        writer.addArc(center, r, 0, 180, layers.DETAIL);
        writer.addArc(center, r, 180, 360, layers.DETAIL);
        writer.addLine({ x: center.x - r, y: center.y }, { x: center.x + r, y: center.y }, layers.DETAIL);
        fitText(writer, center.x, center.y + r * 0.28, 0.085 * sheet.scale, marker.detailId, 1.55 * r, layers.TEXT_MD);
        fitText(writer, center.x, center.y - r * 0.58, 0.065 * sheet.scale, marker.drawingId, 1.55 * r, layers.TEXT_SM);
    });
    return writer.toString();
}
export function resolveLegacyScale(input, options = {}) {
    return chooseSheet(input, options).scale;
}
//# sourceMappingURL=compose.js.map