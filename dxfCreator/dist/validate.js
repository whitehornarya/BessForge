import { CABLE_CLASSES, EQUIPMENT_KINDS, STANDARD_SCALES_FT_PER_IN, TRENCH_CLASSES, } from './constants.js';
import { MAX_ABS_LOCAL_COORDINATE_FT, MAX_ABS_ROTATION_DEG, MAX_EQUIPMENT_DIMENSION_FT, MIN_EQUIPMENT_DIMENSION_FT, quantizeDxfPoint, quantizedPointKey, } from './numeric.js';
const ASCII_TEXT = /^[\x20-\x7E]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,127}$/;
const EPSILON = 1e-9;
function validCoordinate(value) {
    return typeof value === 'number' && Number.isFinite(value) &&
        Math.abs(value) <= MAX_ABS_LOCAL_COORDINATE_FT;
}
function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function pointOnSegment(p, a, b) {
    return Math.abs(cross(a, b, p)) <= EPSILON &&
        p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON &&
        p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}
function segmentsIntersect(a, b, c, d) {
    const abC = cross(a, b, c), abD = cross(a, b, d);
    const cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
        ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON)))
        return true;
    return pointOnSegment(c, a, b) || pointOnSegment(d, a, b) ||
        pointOnSegment(a, c, d) || pointOnSegment(b, c, d);
}
function ringsIntersect(a, b) {
    return a.some((p, i) => b.some((q, j) => segmentsIntersect(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}
function pointInRing(point, ring) {
    if (ring.some((p, i) => pointOnSegment(point, p, ring[(i + 1) % ring.length])))
        return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > point.y) !== (b.y > point.y) &&
            point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)
            inside = !inside;
    }
    return inside;
}
function validRing(value) {
    return Array.isArray(value) && value.length >= 3 &&
        value.every(p => isRecord(p) && validCoordinate(p.x) && validCoordinate(p.y));
}
function quantizedRing(value) {
    return validRing(value) ? value.map(quantizeDxfPoint) : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export class LegacyLayoutValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Legacy layout input is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
        this.name = 'LegacyLayoutValidationError';
        this.issues = issues;
    }
}
export function assertValidLegacyLayoutInput(input) {
    const result = validateLegacyLayoutInput(input);
    if (!result.ok)
        throw new LegacyLayoutValidationError(result.issues);
    return result.value;
}
export function validateLegacyLayoutInput(input) {
    const issues = [];
    const issue = (path, code, message) => issues.push({ path, code, message });
    const record = (value, path) => {
        if (!isRecord(value)) {
            issue(path, 'type.object', 'must be an object');
            return undefined;
        }
        return value;
    };
    const array = (value, path) => {
        if (!Array.isArray(value)) {
            issue(path, 'type.array', 'must be an array');
            return [];
        }
        return value;
    };
    const text = (value, path, allowEmpty = false, maxLength = 128) => {
        if (typeof value !== 'string') {
            issue(path, 'type.string', 'must be a string');
        }
        else if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
            issue(path, 'string.length', `must be ${allowEmpty ? `0..${maxLength}` : `1..${maxLength}`} characters`);
        }
        else if (!ASCII_TEXT.test(value)) {
            issue(path, 'string.ascii', 'must contain printable ASCII only; CR, LF, controls, and Unicode are rejected');
        }
        else if (value.includes('\\') || value.includes('^') || value.includes('%%')) {
            issue(path, 'string.dxfSafe', 'must not contain backslash, caret, or the DXF control sequence %%');
        }
    };
    const id = (value, path) => {
        text(value, path);
        if (typeof value === 'string' && !IDENTIFIER.test(value)) {
            issue(path, 'id.format', 'must use only letters, digits, dot, underscore, colon, hash, slash, or hyphen');
        }
    };
    const number = (value, path, positive = false) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            issue(path, 'number.finite', 'must be a finite number');
        }
        else if (positive && value <= 0) {
            issue(path, 'number.positive', 'must be greater than zero');
        }
    };
    const point = (value, path) => {
        const p = record(value, path);
        if (!p)
            return;
        number(p.x, `${path}.x`);
        number(p.y, `${path}.y`);
        if (typeof p.x === 'number' && Number.isFinite(p.x) && Math.abs(p.x) > MAX_ABS_LOCAL_COORDINATE_FT) {
            issue(`${path}.x`, 'number.coordinateRange', `absolute local coordinate must be <= ${MAX_ABS_LOCAL_COORDINATE_FT} ft`);
        }
        if (typeof p.y === 'number' && Number.isFinite(p.y) && Math.abs(p.y) > MAX_ABS_LOCAL_COORDINATE_FT) {
            issue(`${path}.y`, 'number.coordinateRange', `absolute local coordinate must be <= ${MAX_ABS_LOCAL_COORDINATE_FT} ft`);
        }
    };
    const segment = (a, b, path) => {
        if (!isRecord(a) || !isRecord(b) ||
            !validCoordinate(a.x) || !validCoordinate(a.y) ||
            !validCoordinate(b.x) || !validCoordinate(b.y))
            return;
        if (quantizedPointKey(quantizeDxfPoint(a)) ===
            quantizedPointKey(quantizeDxfPoint(b))) {
            issue(path, 'geometry.quantizedZeroLengthSegment', 'segment endpoints collapse together at six-decimal DXF precision');
        }
    };
    const points = (value, path, min, polygon = false) => {
        const rows = array(value, path);
        if (rows.length < min)
            issue(path, 'geometry.vertices', `must contain at least ${min} points`);
        rows.forEach((p, i) => point(p, `${path}[${i}]`));
        const sourceValid = rows.every(p => isRecord(p) && validCoordinate(p.x) && validCoordinate(p.y));
        if (sourceValid) {
            const raw = rows;
            const pts = raw.map(quantizeDxfPoint);
            for (let i = 0; i + 1 < pts.length; i++) {
                if (quantizedPointKey(pts[i]) === quantizedPointKey(pts[i + 1])) {
                    const exact = raw[i].x === raw[i + 1].x && raw[i].y === raw[i + 1].y;
                    issue(`${path}[${i}]`, exact ? 'geometry.zeroLengthSegment' : 'geometry.quantizedZeroLengthSegment', exact ? 'must not duplicate the next point' :
                        'point collapses to the next point at six-decimal DXF precision');
                }
            }
            if (polygon && pts.length >= 3 &&
                quantizedPointKey(pts[0]) === quantizedPointKey(pts[pts.length - 1])) {
                issue(`${path}[${pts.length - 1}]`, 'geometry.quantizedZeroLengthClosingEdge', 'closing edge collapses at six-decimal DXF precision');
            }
        }
        if (polygon && rows.length >= 3 && sourceValid) {
            const pts = rows.map(quantizeDxfPoint);
            const area = pts.reduce((sum, p, i) => {
                const q = pts[(i + 1) % pts.length];
                return sum + p.x * q.y - q.x * p.y;
            }, 0) / 2;
            if (!Number.isFinite(area) || Math.abs(area) < 1e-8) {
                issue(path, 'geometry.quantizedArea', 'polygon must have non-zero area at six-decimal DXF precision');
            }
            const unique = new Set(pts.map(quantizedPointKey));
            if (unique.size < 3)
                issue(path, 'geometry.distinct', 'polygon must have at least three distinct points');
            let selfIntersects = false;
            for (let i = 0; i < pts.length && !selfIntersects; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                if (quantizedPointKey(a) === quantizedPointKey(b)) {
                    continue;
                }
                for (let j = i + 1; j < pts.length; j++) {
                    if (j === i || j === i + 1 || (i === 0 && j === pts.length - 1))
                        continue;
                    const c = pts[j], d = pts[(j + 1) % pts.length];
                    if (segmentsIntersect(a, b, c, d)) {
                        selfIntersects = true;
                        issue(path, 'geometry.selfIntersection', `edges ${i} and ${j} intersect`);
                        break;
                    }
                }
            }
        }
    };
    const identifiedPolyline = (value, path, polygon = false) => {
        const row = record(value, path);
        if (!row)
            return;
        id(row.id, `${path}.id`);
        points(row.points, `${path}.points`, polygon ? 3 : 2, polygon);
        if (polygon && row.holes !== undefined) {
            const holes = array(row.holes, `${path}.holes`);
            holes.forEach((hole, i) => points(hole, `${path}.holes[${i}]`, 3, true));
            const outer = quantizedRing(row.points);
            if (outer) {
                holes.forEach((hole, i) => {
                    const quantizedHole = quantizedRing(hole);
                    if (!quantizedHole)
                        return;
                    if (!quantizedHole.every(p => pointInRing(p, outer)) || ringsIntersect(outer, quantizedHole)) {
                        issue(`${path}.holes[${i}]`, 'geometry.holeContainment', 'hole must be strictly inside and not touch the outer ring');
                    }
                    for (let j = 0; j < i; j++) {
                        const prior = quantizedRing(holes[j]);
                        if (prior && (ringsIntersect(prior, quantizedHole) ||
                            pointInRing(quantizedHole[0], prior) || pointInRing(prior[0], quantizedHole))) {
                            issue(`${path}.holes[${i}]`, 'geometry.holeOverlap', `must not overlap, touch, or nest with hole ${j}`);
                        }
                    }
                });
            }
        }
    };
    const root = record(input, '$');
    if (!root)
        return { ok: false, issues };
    const title = record(root.title, '$.title');
    if (title) {
        ['projectOwner', 'projectName', 'sheetTitle', 'location'].forEach(key => text(title[key], `$.title.${key}`, false, 80));
        ['drawingNumber', 'revision', 'statusStamp'].forEach(key => text(title[key], `$.title.${key}`, false, 40));
        text(title.clientDrawingNumber, '$.title.clientDrawingNumber', true, 40);
        const notes = array(title.notes, '$.title.notes');
        if (notes.length < 1 || notes.length > 3)
            issue('$.title.notes', 'array.cardinality', 'must contain 1..3 notes');
        notes.forEach((v, i) => text(v, `$.title.notes[${i}]`, false, 72));
        const revisions = array(title.revisions, '$.title.revisions');
        if (revisions.length < 1 || revisions.length > 3)
            issue('$.title.revisions', 'array.cardinality', 'must contain 1..3 revision rows');
        const revisionKeys = new Set();
        revisions.forEach((v, i) => {
            const row = record(v, `$.title.revisions[${i}]`);
            if (row) {
                text(row.revision, `$.title.revisions[${i}].revision`, false, 12);
                text(row.description, `$.title.revisions[${i}].description`, false, 48);
                ['date', 'by', 'checkedBy'].forEach(key => text(row[key], `$.title.revisions[${i}].${key}`, false, 16));
                if (typeof row.revision === 'string') {
                    if (revisionKeys.has(row.revision))
                        issue(`$.title.revisions[${i}].revision`, 'revision.duplicate', 'must be unique');
                    revisionKeys.add(row.revision);
                }
            }
        });
        const engineering = record(title.engineering, '$.title.engineering');
        if (engineering) {
            ['drawnBy', 'designedBy', 'checkedBy', 'approvedBy']
                .forEach(key => text(engineering[key], `$.title.engineering.${key}`, false, 24));
            ['drawnDate', 'designedDate', 'checkedDate', 'approvedDate']
                .forEach(key => text(engineering[key], `$.title.engineering.${key}`, false, 16));
        }
    }
    const rating = record(root.rating, '$.rating');
    if (rating) {
        number(rating.mw, '$.rating.mw', true);
        number(rating.mwh, '$.rating.mwh', true);
    }
    const scale = record(root.scale, '$.scale');
    if (scale) {
        number(scale.preferredFtPerIn, '$.scale.preferredFtPerIn', true);
        if (typeof scale.preferredFtPerIn === 'number' &&
            !STANDARD_SCALES_FT_PER_IN.includes(scale.preferredFtPerIn)) {
            issue('$.scale.preferredFtPerIn', 'scale.standard', 'must be one of STANDARD_SCALES_FT_PER_IN');
        }
        if (typeof scale.autoScale !== 'boolean')
            issue('$.scale.autoScale', 'type.boolean', 'must be a boolean');
    }
    identifiedPolyline(root.siteBoundary, '$.siteBoundary', true);
    identifiedPolyline(root.fence, '$.fence', true);
    const seen = new Map();
    const registerId = (value, path) => {
        if (!isRecord(value) || typeof value.id !== 'string')
            return;
        const prior = seen.get(value.id);
        if (prior)
            issue(`${path}.id`, 'id.duplicate', `duplicates ${prior}`);
        else
            seen.set(value.id, `${path}.id`);
    };
    registerId(root.siteBoundary, '$.siteBoundary');
    registerId(root.fence, '$.fence');
    const collections = ['adjacentFences', 'projectFences', 'existingAccess', 'detailMarkers',
        'roads', 'surfacing', 'equipment', 'cables', 'trenches', 'reservedZones', 'callouts', 'matchLines'];
    const rows = Object.fromEntries(collections.map(k => [k, array(root[k], `$.${k}`)]));
    collections.forEach(k => rows[k].forEach((v, i) => registerId(v, `$.${k}[${i}]`)));
    rows.adjacentFences.forEach((v, i) => identifiedPolyline(v, `$.adjacentFences[${i}]`));
    rows.projectFences.forEach((v, i) => identifiedPolyline(v, `$.projectFences[${i}]`));
    rows.existingAccess.forEach((v, i) => {
        identifiedPolyline(v, `$.existingAccess[${i}]`, true);
        const row = isRecord(v) ? v : undefined;
        if (row?.label !== undefined)
            text(row.label, `$.existingAccess[${i}].label`, true, 64);
    });
    rows.detailMarkers.forEach((v, i) => {
        const path = `$.detailMarkers[${i}]`, row = record(v, path);
        if (!row)
            return;
        id(row.id, `${path}.id`);
        point(row.center, `${path}.center`);
        text(row.detailId, `${path}.detailId`, false, 16);
        text(row.drawingId, `${path}.drawingId`, false, 24);
    });
    rows.roads.forEach((v, i) => {
        identifiedPolyline(v, `$.roads[${i}]`, true);
        const row = isRecord(v) ? v : undefined;
        if (row?.label !== undefined)
            text(row.label, `$.roads[${i}].label`, true, 48);
    });
    rows.surfacing.forEach((v, i) => identifiedPolyline(v, `$.surfacing[${i}]`, true));
    rows.equipment.forEach((v, i) => {
        const path = `$.equipment[${i}]`;
        const row = record(v, path);
        if (!row)
            return;
        id(row.id, `${path}.id`);
        text(row.label, `${path}.label`, false, 32);
        if (typeof row.kind !== 'string' || !EQUIPMENT_KINDS.includes(row.kind)) {
            issue(`${path}.kind`, 'enum.equipmentKind', `must be one of ${EQUIPMENT_KINDS.join(', ')}`);
        }
        point(row.center, `${path}.center`);
        number(row.length, `${path}.length`, true);
        number(row.width, `${path}.width`, true);
        number(row.rotationDeg, `${path}.rotationDeg`);
        for (const key of ['length', 'width']) {
            const value = row[key];
            if (typeof value === 'number' && Number.isFinite(value) &&
                (value < MIN_EQUIPMENT_DIMENSION_FT || value > MAX_EQUIPMENT_DIMENSION_FT)) {
                issue(`${path}.${key}`, 'number.equipmentDimensionRange', `must be ${MIN_EQUIPMENT_DIMENSION_FT}..${MAX_EQUIPMENT_DIMENSION_FT} ft`);
            }
        }
        if (typeof row.rotationDeg === 'number' && Number.isFinite(row.rotationDeg) &&
            Math.abs(row.rotationDeg) > MAX_ABS_ROTATION_DEG) {
            issue(`${path}.rotationDeg`, 'number.rotationRange', `absolute raw rotation must be <= ${MAX_ABS_ROTATION_DEG} degrees`);
        }
        if (row.kind === 'bess') {
            if (row.configuration !== 'A' && row.configuration !== 'C') {
                issue(`${path}.configuration`, 'equipment.bessConfiguration', 'must be A or C when kind is bess');
            }
        }
        else if (row.configuration !== undefined) {
            issue(`${path}.configuration`, 'equipment.unexpectedConfiguration', 'is only allowed when kind is bess');
        }
    });
    rows.cables.forEach((v, i) => {
        const path = `$.cables[${i}]`;
        identifiedPolyline(v, path);
        const row = isRecord(v) ? v : undefined;
        if (typeof row?.class !== 'string' || !CABLE_CLASSES.includes(row.class)) {
            issue(`${path}.class`, 'enum.cableClass', `must be one of ${CABLE_CLASSES.join(', ')}`);
        }
        if (row?.feederName !== undefined)
            text(row.feederName, `${path}.feederName`, false, 24);
    });
    rows.trenches.forEach((v, i) => {
        const path = `$.trenches[${i}]`;
        identifiedPolyline(v, path);
        const row = isRecord(v) ? v : undefined;
        if (typeof row?.class !== 'string' || !TRENCH_CLASSES.includes(row.class)) {
            issue(`${path}.class`, 'enum.trenchClass', `must be one of ${TRENCH_CLASSES.join(', ')}`);
        }
    });
    rows.reservedZones.forEach((v, i) => {
        const path = `$.reservedZones[${i}]`;
        identifiedPolyline(v, path, true);
        const row = isRecord(v) ? v : undefined;
        text(row?.label, `${path}.label`, false, 48);
        if (!['future-augmentation-batteries', 'future-augmentation-inverters', 'underground-exclusion', 'laydown'].includes(String(row?.kind))) {
            issue(`${path}.kind`, 'enum.zoneKind', 'must be a supported future augmentation, underground exclusion, or laydown kind');
        }
    });
    rows.callouts.forEach((v, i) => {
        const path = `$.callouts[${i}]`;
        const row = record(v, path);
        if (!row)
            return;
        id(row.id, `${path}.id`);
        point(row.anchor, `${path}.anchor`);
        point(row.elbow, `${path}.elbow`);
        point(row.textPoint, `${path}.textPoint`);
        segment(row.anchor, row.elbow, `${path}.anchor`);
        segment(row.elbow, row.textPoint, `${path}.elbow`);
        text(row.text, `${path}.text`, false, 96);
    });
    rows.matchLines.forEach((v, i) => {
        const path = `$.matchLines[${i}]`;
        identifiedPolyline(v, path);
        const row = isRecord(v) ? v : undefined;
        text(row?.label, `${path}.label`, false, 32);
    });
    return issues.length
        ? { ok: false, issues }
        : { ok: true, value: input };
}
//# sourceMappingURL=validate.js.map