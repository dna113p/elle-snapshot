// Elle Snapshot: send the current Figma selection to a local snapshot workflow.
//
// Main plugin code can access the Figma document, but cannot use browser APIs
// like fetch directly. The UI iframe performs the localhost POST.

figma.showUI(__html__, { width: 400, height: 620 });

type SerializableSelection = {
  id: string;
  name: string;
  type: string;
  width: number | null;
  height: number | null;
  x: number | null;
  y: number | null;
  pageName: string;
};

type ExportPayload = {
  kind: 'selection-export';
  selection: SerializableSelection | null;
  designEvidence?: DesignEvidenceNode;
  pngBytes?: number[];
  error?: string;
};

type SerializablePaint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: string;
};

type SerializableEffect = {
  type: string;
  visible?: boolean;
  radius?: number;
  color?: string;
  offset?: { x: number; y: number };
};

type DesignEvidenceNode = {
  id: string;
  name: string;
  type: string;
  width: number | null;
  height: number | null;
  x: number | null;
  y: number | null;
  absoluteBounds?: { x: number; y: number; width: number; height: number };
  layout?: Record<string, unknown>;
  typography?: Record<string, unknown>;
  fills?: SerializablePaint[];
  strokes?: SerializablePaint[];
  effects?: SerializableEffect[];
  opacity?: number;
  cornerRadius?: number | string;
  strokeWeight?: number | string;
  characters?: string;
  childCount?: number;
  children?: DesignEvidenceNode[];
};

const isMixed = (value: unknown) => value === figma.mixed;
const finiteNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const numberOrMixed = (value: unknown) => (isMixed(value) ? 'mixed' : finiteNumber(value));

function colorToHex(color: RGB | RGBA, opacity = 1) {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, '0');
  const alpha = 'a' in color ? color.a : opacity;
  const hex = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return alpha < 1 ? `${hex}${channel(alpha)}` : hex;
}

function serializePaints(value: unknown): SerializablePaint[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.slice(0, 8).map((paint) => {
    const item = paint as Paint;
    const serialized: SerializablePaint = {
      type: item.type,
      visible: item.visible,
      opacity: typeof item.opacity === 'number' ? item.opacity : undefined,
    };

    if ('color' in item) {
      serialized.color = colorToHex(item.color, typeof serialized.opacity === 'number' ? serialized.opacity : 1);
    }

    return serialized;
  });
}

function serializeEffects(value: unknown): SerializableEffect[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.slice(0, 8).map((effect) => {
    const item = effect as Effect;
    return {
      type: item.type,
      visible: item.visible,
      radius: 'radius' in item && typeof item.radius === 'number' ? item.radius : undefined,
      color: 'color' in item ? colorToHex(item.color) : undefined,
      offset: 'offset' in item ? item.offset : undefined,
    };
  });
}

function readLayout(node: SceneNode): Record<string, unknown> | undefined {
  const layout = node as SceneNode & Partial<AutoLayoutMixin & ConstraintMixin> & Record<string, unknown>;
  const values: Record<string, unknown> = {};

  for (const key of [
    'layoutMode',
    'primaryAxisSizingMode',
    'counterAxisSizingMode',
    'primaryAxisAlignItems',
    'counterAxisAlignItems',
    'layoutWrap',
    'itemSpacing',
    'counterAxisSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'layoutAlign',
    'layoutGrow',
  ] as const) {
    if (key in layout) {
      values[key] = isMixed(layout[key]) ? 'mixed' : layout[key];
    }
  }

  if ('constraints' in layout && layout.constraints) {
    values.constraints = layout.constraints;
  }

  return Object.keys(values).length > 0 ? values : undefined;
}

function readTypography(node: SceneNode): Record<string, unknown> | undefined {
  if (node.type !== 'TEXT') {
    return undefined;
  }

  const values: Record<string, unknown> = {
    characters: node.characters,
    fontSize: isMixed(node.fontSize) ? 'mixed' : node.fontSize,
    fontName: isMixed(node.fontName) ? 'mixed' : node.fontName,
    fontWeight: isMixed(node.fontWeight) ? 'mixed' : node.fontWeight,
    lineHeight: isMixed(node.lineHeight) ? 'mixed' : node.lineHeight,
    letterSpacing: isMixed(node.letterSpacing) ? 'mixed' : node.letterSpacing,
    textCase: isMixed(node.textCase) ? 'mixed' : node.textCase,
    textDecoration: isMixed(node.textDecoration) ? 'mixed' : node.textDecoration,
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    paragraphSpacing: numberOrMixed(node.paragraphSpacing),
    paragraphIndent: numberOrMixed(node.paragraphIndent),
  };

  return values;
}

function serializeDesignEvidence(node: SceneNode, depth = 0): DesignEvidenceNode {
  const sized = node as SceneNode & Partial<LayoutMixin & GeometryMixin & MinimalFillsMixin & BlendMixin & RectangleCornerMixin>;
  const bounds = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  const children = 'children' in node && depth < 5
    ? node.children.slice(0, 80).map((child) => serializeDesignEvidence(child as SceneNode, depth + 1))
    : undefined;

  const evidence: DesignEvidenceNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    width: finiteNumber(sized.width),
    height: finiteNumber(sized.height),
    x: finiteNumber(node.x),
    y: finiteNumber(node.y),
    absoluteBounds: bounds
      ? {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        }
      : undefined,
    layout: readLayout(node),
    typography: readTypography(node),
    fills: serializePaints('fills' in sized ? sized.fills : undefined),
    strokes: serializePaints('strokes' in sized ? sized.strokes : undefined),
    effects: serializeEffects('effects' in sized ? sized.effects : undefined),
    opacity: 'opacity' in sized && typeof sized.opacity === 'number' ? sized.opacity : undefined,
    cornerRadius: 'cornerRadius' in sized ? numberOrMixed(sized.cornerRadius) || undefined : undefined,
    strokeWeight: 'strokeWeight' in sized ? numberOrMixed(sized.strokeWeight) || undefined : undefined,
    characters: node.type === 'TEXT' ? node.characters : undefined,
    childCount: 'children' in node ? node.children.length : undefined,
    children,
  };

  return evidence;
}

function serializeSelection(node: SceneNode): SerializableSelection {
  const sized = node as SceneNode & Partial<LayoutMixin>;

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: typeof sized.width === 'number' ? sized.width : null,
    height: typeof sized.height === 'number' ? sized.height : null,
    x: typeof node.x === 'number' ? node.x : null,
    y: typeof node.y === 'number' ? node.y : null,
    pageName: figma.currentPage.name,
  };
}

async function exportCurrentSelection(): Promise<ExportPayload> {
  const node = figma.currentPage.selection[0];

  if (!node) {
    return {
      kind: 'selection-export',
      selection: null,
      error: 'No node selected.',
    };
  }

  const selection = serializeSelection(node);
  const designEvidence = serializeDesignEvidence(node);

  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 1 },
    });

    return {
      kind: 'selection-export',
      selection,
      designEvidence,
      pngBytes: Array.from(bytes),
    };
  } catch (error) {
    return {
      kind: 'selection-export',
      selection,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendSelectionToUi() {
  figma.ui.postMessage(await exportCurrentSelection());
}

function sendSelectionMetadataToUi() {
  const node = figma.currentPage.selection[0];
  figma.ui.postMessage({
    kind: 'selection-metadata',
    selection: node ? serializeSelection(node) : null,
  });
}

figma.on('selectionchange', sendSelectionMetadataToUi);

figma.ui.onmessage = async (message: { type?: string; text?: string }) => {
  if (message.type === 'send-selection') {
    await sendSelectionToUi();
    return;
  }

  if (message.type === 'refresh-selection') {
    sendSelectionMetadataToUi();
    return;
  }

  if (message.type === 'notify') {
    figma.notify(message.text || 'Elle Snapshot updated.');
  }
};

// Populate the UI immediately after launch without exporting or posting.
sendSelectionMetadataToUi();
