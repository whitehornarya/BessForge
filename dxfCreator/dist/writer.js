import { formatDxfNumber, normalizeRotationDeg } from './numeric.js';
const MODEL_SPACE_RECORD = '1A';
function esc(value) {
    return value;
}
export class DxfWriter {
    lineTypeScale;
    entities = [];
    layers = [];
    lineTypes = [];
    textStyles = [];
    layerTextStyles = new Map();
    handle = 0x100;
    constructor(lineTypeScale = 1) {
        this.lineTypeScale = lineTypeScale;
        if (!Number.isFinite(lineTypeScale) || lineTypeScale <= 0) {
            throw new Error('DXF line type scale must be a positive finite number');
        }
    }
    nextHandle() {
        return (this.handle++).toString(16).toUpperCase();
    }
    addLayer(layer) {
        this.layers.push(`  0\nLAYER\n  5\n${this.nextHandle()}\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n${layer.name}\n 70\n0\n 62\n${layer.color}\n  6\n${layer.lineType}\n370\n${layer.lineWeight}`);
    }
    addLineType(lineType) {
        const total = lineType.elements.reduce((sum, value) => sum + Math.abs(value), 0);
        let record = `  0\nLTYPE\n  5\n${this.nextHandle()}\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\n${lineType.name}\n 70\n0\n  3\n${lineType.description}\n 72\n65\n 73\n${lineType.elements.length}\n 40\n${formatDxfNumber(total)}\n`;
        lineType.elements.forEach(value => { record += ` 49\n${formatDxfNumber(value)}\n 74\n0\n`; });
        this.lineTypes.push(record);
    }
    addTextStyle(style) {
        this.textStyles.push(`  0\nSTYLE\n  5\n${this.nextHandle()}\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbTextStyleTableRecord\n  2\n${style.name}\n 70\n0\n 40\n0\n 41\n${formatDxfNumber(style.widthFactor ?? 1)}\n 50\n${formatDxfNumber(style.obliqueAngle ?? 0)}\n 71\n0\n 42\n${formatDxfNumber(style.lastHeight ?? 0.1)}\n  3\n${style.fontFile}\n  4\n${style.bigFontFile ?? ''}`);
    }
    setLayerTextStyle(layer, style) {
        this.layerTextStyles.set(layer, style);
    }
    entity(type, layer) {
        return `  0\n${type}\n  5\n${this.nextHandle()}\n330\n${MODEL_SPACE_RECORD}\n100\nAcDbEntity\n  8\n${layer}`;
    }
    addLine(a, b, layer, color) {
        let s = this.entity('LINE', layer);
        if (color !== undefined)
            s += `\n 62\n${color}`;
        s += `\n100\nAcDbLine\n 10\n${formatDxfNumber(a.x)}\n 20\n${formatDxfNumber(a.y)}\n 30\n0\n 11\n${formatDxfNumber(b.x)}\n 21\n${formatDxfNumber(b.y)}\n 31\n0`;
        this.entities.push(s);
    }
    addPolyline(points, layer, closed = false, color) {
        if (points.length < 2)
            throw new Error('LWPOLYLINE requires at least two points');
        let s = this.entity('LWPOLYLINE', layer);
        if (color !== undefined)
            s += `\n 62\n${color}`;
        s += `\n100\nAcDbPolyline\n 90\n${points.length}\n 70\n${closed ? 1 : 0}`;
        for (const point of points)
            s += `\n 10\n${formatDxfNumber(point.x)}\n 20\n${formatDxfNumber(point.y)}`;
        this.entities.push(s);
    }
    addArc(center, radius, startDeg, endDeg, layer) {
        this.entities.push(`${this.entity('ARC', layer)}\n100\nAcDbCircle\n 10\n${formatDxfNumber(center.x)}\n 20\n${formatDxfNumber(center.y)}\n 30\n0\n 40\n${formatDxfNumber(radius)}\n100\nAcDbArc\n 50\n${formatDxfNumber(normalizeRotationDeg(startDeg))}\n 51\n${formatDxfNumber(normalizeRotationDeg(endDeg))}`);
    }
    addText(point, height, text, layer, rotationDeg = 0, style) {
        const rotation = normalizeRotationDeg(rotationDeg);
        let s = `${this.entity('TEXT', layer)}\n100\nAcDbText\n 10\n${formatDxfNumber(point.x)}\n 20\n${formatDxfNumber(point.y)}\n 30\n0\n 40\n${formatDxfNumber(height)}\n  1\n${esc(text)}`;
        if (rotation)
            s += `\n 50\n${formatDxfNumber(rotation)}`;
        const textStyle = style ?? this.layerTextStyles.get(layer);
        if (textStyle && textStyle !== 'Standard')
            s += `\n  7\n${textStyle}`;
        s += '\n100\nAcDbText';
        this.entities.push(s);
    }
    addCenteredText(point, height, text, layer, rotationDeg = 0, style) {
        const rotation = normalizeRotationDeg(rotationDeg);
        let s = `${this.entity('TEXT', layer)}\n100\nAcDbText\n 10\n${formatDxfNumber(point.x)}\n 20\n${formatDxfNumber(point.y)}\n 30\n0\n 40\n${formatDxfNumber(height)}\n  1\n${esc(text)}`;
        if (rotation)
            s += `\n 50\n${formatDxfNumber(rotation)}`;
        const textStyle = style ?? this.layerTextStyles.get(layer);
        if (textStyle && textStyle !== 'Standard')
            s += `\n  7\n${textStyle}`;
        s += `\n 72\n1\n 11\n${formatDxfNumber(point.x)}\n 21\n${formatDxfNumber(point.y)}\n 31\n0\n100\nAcDbText`;
        this.entities.push(s);
    }
    addHatch(loops, layer, pattern, color) {
        if (loops.length === 0 || loops.some(loop => loop.length < 3)) {
            throw new Error('HATCH loops require at least three points');
        }
        const solid = pattern === 'SOLID';
        let s = this.entity('HATCH', layer);
        if (color !== undefined)
            s += `\n 62\n${color}`;
        s += `\n100\nAcDbHatch\n 10\n0\n 20\n0\n 30\n0\n210\n0\n220\n0\n230\n1\n  2\n${pattern}\n 70\n${solid ? 1 : 0}\n 71\n0\n 91\n${loops.length}`;
        loops.forEach((loop, index) => {
            s += `\n 92\n${index === 0 ? 3 : 18}\n 72\n0\n 73\n1\n 93\n${loop.length}`;
            loop.forEach(point => { s += `\n 10\n${formatDxfNumber(point.x)}\n 20\n${formatDxfNumber(point.y)}`; });
            s += '\n 97\n0';
        });
        s += `\n 75\n0\n 76\n${solid ? 1 : 0}`;
        if (!solid) {
            const off = 3 / Math.SQRT2;
            const families = pattern === 'ANSI37' ? [45, 135] : [45];
            s += `\n 52\n0\n 41\n${formatDxfNumber(this.lineTypeScale)}\n 77\n0\n 78\n${families.length}`;
            families.forEach(angle => {
                s += `\n 53\n${angle}\n 43\n0\n 44\n0\n 45\n${formatDxfNumber(-off)}\n 46\n${formatDxfNumber(angle === 135 ? -off : off)}\n 79\n0`;
            });
        }
        s += '\n 98\n0';
        this.entities.push(s);
    }
    toString() {
        const seed = this.handle.toString(16).toUpperCase();
        let dxf = `  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  9\n$HANDSEED\n  5\n${seed}\n  9\n$INSUNITS\n 70\n2\n  9\n$LTSCALE\n 40\n${formatDxfNumber(this.lineTypeScale)}\n  0\nENDSEC\n`;
        dxf += '  0\nSECTION\n  2\nCLASSES\n  0\nENDSEC\n';
        dxf += '  0\nSECTION\n  2\nTABLES\n';
        dxf += '  0\nTABLE\n  2\nVPORT\n  5\n8\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n';
        dxf += '  0\nVPORT\n  5\n29\n330\n8\n100\nAcDbSymbolTableRecord\n100\nAcDbViewportTableRecord\n  2\n*Active\n 70\n0\n  0\nENDTAB\n';
        dxf += `  0\nTABLE\n  2\nLTYPE\n  5\n5\n330\n0\n100\nAcDbSymbolTable\n 70\n${7 + this.lineTypes.length}\n`;
        const ltypes = [
            ['14', 'ByBlock', '', []],
            ['15', 'ByLayer', '', []],
            ['16', 'CONTINUOUS', 'Solid line', []],
            ['17', 'DASHED', 'Dashed', [12.5, -2.5]],
            ['18', 'DASHED2', 'Short dash', [6, -3]],
            ['19', 'DASHDOT', 'Dash dot', [12, -3, 0, -3]],
            ['1E', 'DOT', 'Dotted', [0, -2.5]],
        ];
        for (const [handle, name, description, elements] of ltypes) {
            const total = elements.reduce((sum, value) => sum + Math.abs(value), 0);
            dxf += `  0\nLTYPE\n  5\n${handle}\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\n${name}\n 70\n0\n  3\n${description}\n 72\n65\n 73\n${elements.length}\n 40\n${formatDxfNumber(total)}\n`;
            elements.forEach(value => { dxf += ` 49\n${formatDxfNumber(value)}\n 74\n0\n`; });
        }
        if (this.lineTypes.length)
            dxf += this.lineTypes.join('');
        dxf += '  0\nENDTAB\n';
        dxf += `  0\nTABLE\n  2\nLAYER\n  5\n2\n330\n0\n100\nAcDbSymbolTable\n 70\n${this.layers.length + 1}\n`;
        dxf += '  0\nLAYER\n  5\n10\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n0\n 70\n0\n 62\n7\n  6\nCONTINUOUS\n370\n-3\n';
        dxf += `${this.layers.join('\n')}\n  0\nENDTAB\n`;
        dxf += `  0\nTABLE\n  2\nSTYLE\n  5\n3\n330\n0\n100\nAcDbSymbolTable\n 70\n${1 + this.textStyles.length}\n`;
        dxf += '  0\nSTYLE\n  5\n11\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbTextStyleTableRecord\n  2\nStandard\n 70\n0\n 40\n0\n 41\n1\n 50\n0\n 71\n0\n 42\n2.5\n  3\ntxt\n  4\n\n  0\nENDTAB\n';
        if (this.textStyles.length) {
            dxf = dxf.slice(0, -'  0\nENDTAB\n'.length);
            dxf += `${this.textStyles.join('\n')}\n  0\nENDTAB\n`;
        }
        dxf += '  0\nTABLE\n  2\nVIEW\n  5\n6\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n';
        dxf += '  0\nTABLE\n  2\nUCS\n  5\n7\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n';
        dxf += '  0\nTABLE\n  2\nAPPID\n  5\n9\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n  0\nAPPID\n  5\n12\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nACAD\n 70\n0\n  0\nENDTAB\n';
        dxf += '  0\nTABLE\n  2\nDIMSTYLE\n  5\nA\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n100\nAcDbDimStyleTable\n 71\n0\n  0\nENDTAB\n';
        dxf += `  0\nTABLE\n  2\nBLOCK_RECORD\n  5\n1\n330\n0\n100\nAcDbSymbolTable\n 70\n2\n  0\nBLOCK_RECORD\n  5\n${MODEL_SPACE_RECORD}\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Model_Space\n  0\nBLOCK_RECORD\n  5\n1B\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Paper_Space\n  0\nENDTAB\n  0\nENDSEC\n`;
        dxf += `  0\nSECTION\n  2\nBLOCKS\n  0\nBLOCK\n  5\n20\n330\n${MODEL_SPACE_RECORD}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Model_Space\n 70\n0\n 10\n0\n 20\n0\n 30\n0\n  3\n*Model_Space\n  1\n\n  0\nENDBLK\n  5\n21\n330\n${MODEL_SPACE_RECORD}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd\n`;
        dxf += '  0\nBLOCK\n  5\n1C\n330\n1B\n100\nAcDbEntity\n 67\n1\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Paper_Space\n 70\n0\n 10\n0\n 20\n0\n 30\n0\n  3\n*Paper_Space\n  1\n\n  0\nENDBLK\n  5\n1D\n330\n1B\n100\nAcDbEntity\n 67\n1\n  8\n0\n100\nAcDbBlockEnd\n  0\nENDSEC\n';
        dxf += `  0\nSECTION\n  2\nENTITIES\n${this.entities.join('\n')}\n  0\nENDSEC\n`;
        dxf += '  0\nSECTION\n  2\nOBJECTS\n  0\nDICTIONARY\n  5\nC\n330\n0\n100\nAcDbDictionary\n281\n1\n  3\nACAD_GROUP\n350\nD\n  0\nDICTIONARY\n  5\nD\n330\nC\n100\nAcDbDictionary\n281\n1\n  0\nENDSEC\n  0\nEOF\n';
        return dxf;
    }
}
//# sourceMappingURL=writer.js.map