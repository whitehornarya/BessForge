export interface Point {
    x: number;
    y: number;
}
export type EquipmentKind = 'bess' | 'inverter' | 'aux-transformer' | 'aux-distribution' | 'fiber-junction-box' | 'junction-box' | 'substation';
export type CableClass = 'bess-feeder-14a1' | 'bess-feeder-14a2' | 'bess-feeder-14b1' | 'bess-feeder-14b2' | 'bess-feeder-15a1' | 'bess-feeder-15a2' | 'bess-feeder-15b1' | 'bess-feeder-15b2' | 'aux-feeder' | 'dc-negative' | 'dc-positive' | 'fiber';
export type TrenchClass = 'mvac' | 'dc' | 'aux-fiber';
export type HatchPattern = 'SOLID' | 'ANSI31' | 'ANSI37';
export type LegacyCalibrationProfile = 'legacy-v1' | 'car-d-b005-1';
export interface IdentifiedPolyline {
    id: string;
    points: Point[];
}
export interface IdentifiedPolygon extends IdentifiedPolyline {
    holes?: Point[][];
}
interface EquipmentBase {
    id: string;
    label: string;
    center: Point;
    length: number;
    width: number;
    rotationDeg: number;
}
export interface BessEquipment extends EquipmentBase {
    kind: 'bess';
    configuration: 'A' | 'C';
}
export interface NonBessEquipment extends EquipmentBase {
    kind: Exclude<EquipmentKind, 'bess'>;
    configuration?: never;
}
export type Equipment = BessEquipment | NonBessEquipment;
export interface Road extends IdentifiedPolygon {
    label?: string;
}
export interface CableRun extends IdentifiedPolyline {
    class: CableClass;
    feederName?: string;
}
export interface TrenchRun extends IdentifiedPolyline {
    class: TrenchClass;
}
export interface ReservedZone extends IdentifiedPolygon {
    kind: 'future-augmentation-batteries' | 'future-augmentation-inverters' | 'underground-exclusion' | 'laydown';
    label: string;
}
export interface DetailMarker {
    id: string;
    center: Point;
    detailId: string;
    drawingId: string;
}
export interface Callout {
    id: string;
    anchor: Point;
    elbow: Point;
    textPoint: Point;
    text: string;
}
export interface MatchLine extends IdentifiedPolyline {
    label: string;
}
export interface RevisionRow {
    revision: string;
    description: string;
    date: string;
    by: string;
    checkedBy: string;
}
export interface EngineeringRecord {
    drawnBy: string;
    designedBy: string;
    checkedBy: string;
    approvedBy: string;
    drawnDate: string;
    designedDate: string;
    checkedDate: string;
    approvedDate: string;
}
export interface LegacyTitleMetadata {
    projectOwner: string;
    projectName: string;
    sheetTitle: string;
    drawingNumber: string;
    clientDrawingNumber: string;
    revision: string;
    location: string;
    statusStamp: string;
    notes: string[];
    revisions: RevisionRow[];
    engineering: EngineeringRecord;
}
export interface ProjectRating {
    mw: number;
    mwh: number;
}
export interface ScalePreference {
    preferredFtPerIn: number;
    autoScale: boolean;
}
export interface LegacyLayoutInput {
    title: LegacyTitleMetadata;
    rating: ProjectRating;
    scale: ScalePreference;
    siteBoundary: IdentifiedPolygon;
    fence: IdentifiedPolygon;
    adjacentFences: IdentifiedPolyline[];
    projectFences: IdentifiedPolyline[];
    existingAccess: Road[];
    detailMarkers: DetailMarker[];
    roads: Road[];
    surfacing: IdentifiedPolygon[];
    equipment: Equipment[];
    cables: CableRun[];
    trenches: TrenchRun[];
    reservedZones: ReservedZone[];
    callouts: Callout[];
    matchLines: MatchLine[];
}
export interface LegacyBuildOptions {
    filename?: string;
    scaleFtPerIn?: number;
    autoScale?: boolean;
    calibrationProfile?: LegacyCalibrationProfile;
}
export type LegacyTemplateBuildOptions = Omit<LegacyBuildOptions, 'calibrationProfile'>;
export type LegacyTemplateInputSource = LegacyLayoutInput | (() => LegacyLayoutInput);
export interface LegacyExportArtifact {
    filename: string;
    mimeType: 'application/dxf';
    pageRole: 'page-2-legacy-bess-layout';
    bytes: Uint8Array;
    text: string;
}
export type LegacyTemplateExportResult = Readonly<{
    handled: false;
}> | Readonly<{
    handled: true;
    artifact: LegacyExportArtifact;
}>;
export interface ValidationIssue {
    path: string;
    code: string;
    message: string;
}
export type ValidationResult = {
    ok: true;
    value: LegacyLayoutInput;
} | {
    ok: false;
    issues: ValidationIssue[];
};
export {};
//# sourceMappingURL=types.d.ts.map