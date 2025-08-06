// code.ts

// 型定義
interface TextContent {
  id: string;
  text: string;
}

interface SelectionData {
  id: string;
  name: string;
  type: string;
}

interface SettingsData {
  provider: 'openai' | 'gemini' | 'gemini-pro';
  openAiKey: string;
  geminiKey: string;
  format: string;
  htmlRules: string;
  pugRules: string;
  otherRules: string;
  sendPngData: boolean;
}

// グループ化関連の型定義
interface GroupingResult {
  success: boolean;
  groupedNode?: GroupNode | FrameNode;
  originalNodes: readonly SceneNode[];
  error?: string;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// PNGエクスポート関連の型定義
interface PngExportOptions {
  scale: number;
  format: 'PNG';
  constraint?: { type: 'SCALE', value: number } | { type: 'WIDTH' | 'HEIGHT', value: number };
}

interface PngExportResult {
  success: boolean;
  pngData?: string; // Base64エンコードされたPNGデータ
  error?: string;
  metadata: {
    originalNodeCount: number;
    exportScale: number;
    fileSize: number;
    dimensions: { width: number; height: number };
  };
}

// プラグインのメイン処理
figma.showUI(__html__, { width: 480, height: 600 });

// クライアントストレージから設定を読み込む
async function loadSettings(): Promise<void> {
  const provider = await figma.clientStorage.getAsync('provider') || 'openai';
  const openAiKey = await figma.clientStorage.getAsync('openAiKey') || '';
  const geminiKey = await figma.clientStorage.getAsync('geminiKey') || '';
  const format = await figma.clientStorage.getAsync('format') || 'html';
  const htmlRules = await figma.clientStorage.getAsync('format-html') || '';
  const pugRules = await figma.clientStorage.getAsync('format-pug') || '';
  const otherRules = await figma.clientStorage.getAsync('format-other') || '';
  const sendPngData = (await figma.clientStorage.getAsync('sendPngData'));
  figma.ui.postMessage({
    type: "load-settings",
    data: {
      provider,
      openAiKey,
      geminiKey,
      format,
      htmlRules,
      pugRules,
      otherRules,
      sendPngData: sendPngData === undefined ? true : sendPngData
    } as SettingsData
  });
}

// 選択要素の変更を監視し、UIへ送信
figma.on("selectionchange", () => {
  const selection = figma.currentPage.selection;
  const data: SelectionData[] = selection.map(node => ({
    id: node.id,
    name: node.name,
    type: node.type
  }));
  figma.ui.postMessage({ type: "selection", data });
});

// 再帰的にテキストを抽出
async function extractTextsFromNode(node: BaseNode): Promise<TextContent[]> {
  let texts: TextContent[] = [];

  if (node.type === "TEXT") {
    const textNode = node as TextNode;

    texts.push({
      id: textNode.id,
      text: textNode.characters
        .replace(/\u2028/g, '\n')        // Unicode改行
        .replace(/\\n/g, '\n')           // バックスラッシュn → 改行
        .replace(/\r\n/g, '\n')          // CRLF → LF
        .replace(/\r/g, '\n')            // CR → LF
    });
  } else if ("children" in node) {
    for (const child of node.children) {
      texts = texts.concat(await extractTextsFromNode(child));
    }
  }

  return texts;
}

// テキストコンテンツの抽出
async function extractTextContent(nodeId: string): Promise<TextContent[]> {
  try {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      console.warn(`Node with ID ${nodeId} not found`);
      return [];
    }

    return extractTextsFromNode(node);
  } catch (error) {
    console.error(`Error accessing node ${nodeId}:`, error);
    return [];
  }
}

// グループ化機能の実装

// 選択された要素の境界ボックスを計算
function calculateBoundingBox(nodes: readonly SceneNode[]): BoundingBox {
  if (nodes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    if ('x' in node && 'y' in node && 'width' in node && 'height' in node) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

// コンテナタイプ（グループまたはフレーム）を決定
function determineContainerType(_nodes: readonly SceneNode[]): 'group' | 'frame' {
  // 安全性を優先してフレームを使用
  // グループ化でのエラーを避けるため、常にフレームを使用
  return 'frame';
}

// 選択された要素を単一のグループまたはフレームにまとめる
async function createGroupFromSelection(selection: readonly SceneNode[]): Promise<GroupingResult> {
  try {
    // 要件1.4: 選択要素なしのエラーハンドリング
    if (selection.length === 0) {
      return {
        success: false,
        originalNodes: selection,
        error: "選択された要素がありません"
      };
    }

    // 選択された要素の有効性をチェック
    const validNodes = selection.filter(node => {
      try {
        // ノードが削除されていないかチェック
        if (node.removed) {
          // console.warn(`ノード ${node.id} は既に削除されています`);
          return false;
        }
        // ノード名にアクセスして有効性を確認
        const _ = node.name;
        return true;
      } catch (error) {
        // console.warn(`ノード ${node.id} は無効です:`, error);
        return false;
      }
    });

    if (validNodes.length === 0) {
      return {
        success: false,
        originalNodes: selection,
        error: "選択された要素がすべて無効または削除されています"
      };
    }

    if (validNodes.length !== selection.length) {
      // console.warn(`${selection.length - validNodes.length}個の無効なノードをスキップしました`);
    }

    // 単一要素の場合はそのまま返す（一時ノードではないことを明示）
    if (validNodes.length === 1) {
      const singleNode = validNodes[0];

      // ノードタイプの検証（エクスポート可能なノードタイプのみ許可）
      const exportableTypes = ['GROUP', 'FRAME', 'COMPONENT', 'INSTANCE', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE'];
      if (!exportableTypes.includes(singleNode.type)) {
        return {
          success: false,
          originalNodes: selection,
          error: `サポートされていないノードタイプです: ${singleNode.type}`
        };
      }

      return {
        success: true,
        groupedNode: singleNode as GroupNode | FrameNode,
        originalNodes: selection
      };
    }

    // 境界ボックスを計算
    const boundingBox = calculateBoundingBox(validNodes);

    // 境界ボックスの有効性をチェック
    if (boundingBox.width <= 0 || boundingBox.height <= 0) {
      return {
        success: false,
        originalNodes: selection,
        error: "選択された要素の境界ボックスが無効です（幅または高さが0以下）"
      };
    }

    // コンテナタイプを決定
    const containerType = determineContainerType(validNodes);

    // 親ノードを取得し、すべての選択要素が同じ親を持つことを確認
    const firstParent = validNodes[0].parent;
    if (!firstParent) {
      return {
        success: false,
        originalNodes: selection,
        error: "親ノードが見つかりません"
      };
    }

    // すべてのノードが同じ親を持つかチェック
    const allSameParent = validNodes.every(node => node.parent === firstParent);
    if (!allSameParent) {
      return {
        success: false,
        originalNodes: selection,
        error: "選択された要素が異なる親ノードに属しています。同じ親ノード内の要素のみを選択してください"
      };
    }

    const parentNode = firstParent;

    // 選択要素の元の位置を記録
    const originalPositions = validNodes.map(node => {
      if ('x' in node && 'y' in node) {
        return { node, x: node.x, y: node.y };
      }
      return { node, x: 0, y: 0 };
    });

    let containerNode: GroupNode | FrameNode;

    try {
      if (containerType === 'frame') {
        // フレームを作成
        containerNode = figma.createFrame();
        containerNode.name = "Temporary Export Frame";
        containerNode.x = boundingBox.x;
        containerNode.y = boundingBox.y;
        containerNode.resize(boundingBox.width, boundingBox.height);

        // 背景を透明に設定
        containerNode.fills = [];
      } else {
        // グループを作成（まず仮のフレームを作成してからグループ化）
        const tempFrame = figma.createFrame();
        tempFrame.x = boundingBox.x;
        tempFrame.y = boundingBox.y;
        tempFrame.resize(boundingBox.width, boundingBox.height);
        tempFrame.fills = [];

        // 親ノードに追加
        if ('appendChild' in parentNode) {
          (parentNode as BaseNode & ChildrenMixin).appendChild(tempFrame);
        } else {
          throw new Error("親ノードが子要素を追加できません");
        }

        containerNode = tempFrame;
      }

      // 親ノードに追加
      if ('appendChild' in parentNode) {
        (parentNode as BaseNode & ChildrenMixin).appendChild(containerNode);
      } else {
        throw new Error("親ノードが子要素を追加できません");
      }
    } catch (nodeCreationError: unknown) {
      const errorMessage = nodeCreationError instanceof Error ? nodeCreationError.message : String(nodeCreationError);
      return {
        success: false,
        originalNodes: selection,
        error: `コンテナノードの作成に失敗しました: ${errorMessage}`
      };
    }

    // 選択された要素をコンテナに移動し、相対位置を維持
    try {
      for (const { node, x, y } of originalPositions) {
        try {
          if ('x' in node && 'y' in node) {
            // 相対位置を計算
            const relativeX = x - boundingBox.x;
            const relativeY = y - boundingBox.y;

            // ノードをコンテナに移動
            containerNode.appendChild(node);

            // 相対位置を設定
            node.x = relativeX;
            node.y = relativeY;
          } else {
            // 位置情報がないノードもコンテナに追加
            containerNode.appendChild(node);
          }
        } catch (nodeError: unknown) {
          const _nodeErrorMessage = nodeError instanceof Error ? nodeError.message : String(nodeError);
          // console.warn(`ノード ${node.id} の移動中にエラーが発生しました: ${_nodeErrorMessage}`);
          // 個別のノードエラーは警告として扱い、処理を継続
        }
      }
    } catch (movementError: unknown) {
      // コンテナを削除してエラーを返す
      try {
        containerNode.remove();
      } catch (removeError) {
        // console.warn("エラー時のコンテナ削除に失敗しました:", removeError);
      }

      const errorMessage = movementError instanceof Error ? movementError.message : String(movementError);
      return {
        success: false,
        originalNodes: selection,
        error: `要素の移動中にエラーが発生しました: ${errorMessage}`
      };
    }

    // グループタイプの場合、実際のグループに変換
    if (containerType === 'group' && 'children' in parentNode) {
      try {
        // 一時フレーム内の要素を取得
        const childrenToGroup = [...containerNode.children];

        if (childrenToGroup.length === 0) {
          throw new Error("グループ化する子要素がありません");
        }

        // 一時フレームの位置を保存
        const frameX = containerNode.x;
        const frameY = containerNode.y;

        // 子要素を親ノードに移動（グループ化の準備）
        for (const child of childrenToGroup) {
          if ('x' in child && 'y' in child) {
            // 絶対位置を計算
            const absoluteX = frameX + child.x;
            const absoluteY = frameY + child.y;

            // 親ノードに移動
            (parentNode as BaseNode & ChildrenMixin).appendChild(child);

            // 絶対位置を設定
            child.x = absoluteX;
            child.y = absoluteY;
          } else {
            (parentNode as BaseNode & ChildrenMixin).appendChild(child);
          }
        }

        // 一時フレームを削除
        containerNode.remove();

        // 要素をグループ化
        const groupNode = figma.group(childrenToGroup, parentNode as BaseNode & ChildrenMixin);
        groupNode.name = "Temporary Export Group";
        containerNode = groupNode;
      } catch (groupError: unknown) {
        const errorMessage = groupError instanceof Error ? groupError.message : String(groupError);
        return {
          success: false,
          originalNodes: selection,
          error: `グループ化の最終段階でエラーが発生しました: ${errorMessage}`
        };
      }
    }

    return {
      success: true,
      groupedNode: containerNode,
      originalNodes: selection
    };

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      originalNodes: selection,
      error: `グループ化中にエラーが発生しました: ${errorMessage}`
    };
  }
}

// PNGエクスポート機能の実装

// Base64エンコーディング関数
function encodeToBase64(pngData: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;

  while (i < pngData.length) {
    const a = pngData[i++];
    const b = i < pngData.length ? pngData[i++] : 0;
    const c = i < pngData.length ? pngData[i++] : 0;

    const bitmap = (a << 16) | (b << 8) | c;

    result += chars.charAt((bitmap >> 18) & 63);
    result += chars.charAt((bitmap >> 12) & 63);
    result += i - 2 < pngData.length ? chars.charAt((bitmap >> 6) & 63) : '=';
    result += i - 1 < pngData.length ? chars.charAt(bitmap & 63) : '=';
  }

  return result;
}

// ファイルサイズ最適化関数
async function optimizeFileSize(node: GroupNode | FrameNode, maxSizeKB: number = 512): Promise<{ data: Uint8Array; scale: number }> {
  const maxSizeBytes = maxSizeKB * 512;
  let pngData: Uint8Array;

  // まず0.5を試し、必要に応じてスケールを調整
  // 小さな要素の場合は高解像度、大きな要素の場合は低解像度を使用
  const nodeWidth = 'width' in node ? node.width : 0;
  const nodeHeight = 'height' in node ? node.height : 0;
  const nodeArea = nodeWidth * nodeHeight;

  let scaleSteps: number[];
  if (nodeArea < 10000) { // 小さな要素（100x100未満）
    scaleSteps = [1, 0.75, 0.5, 0.4]; // 高解像度を優先
  } else if (nodeArea < 50000) { // 中程度の要素
    scaleSteps = [0.75, 0.5, 0.4, 0.3]; // バランス重視
  } else { // 大きな要素
    scaleSteps = [0.5, 0.4, 0.3]; // 低解像度を優先
  }

  for (const currentScale of scaleSteps) {
    try {
      const exportOptions: ExportSettings = {
        format: 'PNG',
        constraint: { type: 'SCALE', value: currentScale }
      };

      pngData = await node.exportAsync(exportOptions);

      if (pngData.byteLength <= maxSizeBytes) {
        return { data: pngData, scale: currentScale };
      }
    } catch (error) {
      console.warn(`PNG export failed at scale ${currentScale}:`, error);
      continue;
    }
  }

  // 最小スケールでも大きすぎる場合は、幅制限を試す
  try {
    const nodeWidth = 'width' in node ? node.width : 800;
    const widthConstraints = [800, 600, 400, 300];

    for (const maxWidth of widthConstraints) {
      if (maxWidth >= nodeWidth) continue;

      const exportOptions: ExportSettings = {
        format: 'PNG',
        constraint: { type: 'WIDTH', value: maxWidth }
      };

      pngData = await node.exportAsync(exportOptions);

      if (pngData.byteLength <= maxSizeBytes) {
        const actualScale = maxWidth / nodeWidth;
        return { data: pngData, scale: actualScale };
      }
    }
  } catch (error) {
    console.warn('PNG export with width constraint failed:', error);
  }

  // すべて失敗した場合は0.5で返す
  const fallbackOptions: ExportSettings = {
    format: 'PNG',
    constraint: { type: 'SCALE', value: 0.5 }
  };

  pngData = await node.exportAsync(fallbackOptions);
  return { data: pngData, scale: 0.5 };
}

// メインのPNGエクスポート関数
async function exportToPng(node: GroupNode | FrameNode, options?: Partial<PngExportOptions>): Promise<PngExportResult> {
  try {
    if (!node) {
      return {
        success: false,
        error: "エクスポートするノードが指定されていません",
        metadata: {
          originalNodeCount: 0,
          exportScale: 0,
          fileSize: 0,
          dimensions: { width: 0, height: 0 }
        }
      };
    }

    // デフォルトオプションを設定（将来の拡張用）
    const defaultOptions: PngExportOptions = {
      scale: 0.5,
      format: 'PNG'
    };

    // オプションをマージ（現在は使用していないが、将来の拡張用）
    const _exportOptions = { ...defaultOptions, ...options };

    // ノードの寸法を取得
    const nodeWidth = 'width' in node ? node.width : 0;
    const nodeHeight = 'height' in node ? node.height : 0;

    if (nodeWidth === 0 || nodeHeight === 0) {
      return {
        success: false,
        error: "ノードの寸法が無効です",
        metadata: {
          originalNodeCount: 0,
          exportScale: 0,
          fileSize: 0,
          dimensions: { width: nodeWidth, height: nodeHeight }
        }
      };
    }

    // ファイルサイズ最適化を実行
    const { data: pngData, scale: actualScale } = await optimizeFileSize(node);

    // Base64エンコーディング
    const base64Data = encodeToBase64(pngData);

    // 元のノード数を計算
    let originalNodeCount = 0;
    if ('children' in node) {
      originalNodeCount = node.children.length;
    } else {
      originalNodeCount = 1;
    }

    return {
      success: true,
      pngData: base64Data,
      metadata: {
        originalNodeCount,
        exportScale: actualScale,
        fileSize: pngData.byteLength,
        dimensions: { width: nodeWidth, height: nodeHeight }
      }
    };

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `PNGエクスポート中にエラーが発生しました: ${errorMessage}`,
      metadata: {
        originalNodeCount: 0,
        exportScale: 0,
        fileSize: 0,
        dimensions: { width: 0, height: 0 }
      }
    };
  }
}

// クリーンアップ機能の実装

// 一時的に作成されたグループ/フレームを削除し、中の要素を元の場所に戻す
async function cleanupTemporaryNode(node: GroupNode | FrameNode, parentNode?: BaseNode): Promise<SceneNode[]> {
  try {
    if (!node) {
      console.warn("クリーンアップ対象のノードがnullまたはundefinedです");
      return [];
    }

    // ノードが削除されているかチェック
    if (node.removed) {
      console.warn("クリーンアップ対象のノードは既に削除されています");
      return [];
    }

    // ノード名に安全にアクセス
    let nodeName: string;
    try {
      nodeName = node.name;
    } catch (nameError) {
      console.warn("ノード名の取得に失敗しました。ノードが無効な可能性があります:", nameError);
      return [];
    }

    // ノードが一時的なものかチェック（名前で判定）
    const isTemporary = nodeName.includes("Temporary Export");

    if (!isTemporary) {
      console.warn(`ノード "${nodeName}" は一時ノードではないため削除をスキップしました`);
      return [];
    }

    // 一時ノード内の子要素を取得
    const childrenToRestore: SceneNode[] = [];
    try {
      if ('children' in node && node.children && node.children.length > 0) {
        // 子要素をコピー（削除前に参照を保存）
        childrenToRestore.push(...node.children.slice());
      }
    } catch (childrenError) {
      console.warn("子要素の取得に失敗しました:", childrenError);
      // 子要素が取得できない場合は、ノードだけ削除して終了
    }

    // 親ノードが指定されている場合、子要素を親に移動
    if (parentNode && 'appendChild' in parentNode && childrenToRestore.length > 0) {
      // 一時ノードの位置情報を安全に取得
      let tempNodeX = 0;
      let tempNodeY = 0;
      try {
        if ('x' in node) tempNodeX = node.x;
        if ('y' in node) tempNodeY = node.y;
      } catch (positionError) {
        console.warn("ノードの位置情報取得に失敗しました:", positionError);
      }

      // 子要素を親ノードに移動し、絶対位置を復元
      for (const child of childrenToRestore) {
        if ('x' in child && 'y' in child) {
          // 絶対位置を計算
          const absoluteX = tempNodeX + child.x;
          const absoluteY = tempNodeY + child.y;

          // 親ノードに移動
          if (parentNode && 'appendChild' in parentNode) {
            (parentNode as BaseNode & ChildrenMixin).appendChild(child);
          }

          // 絶対位置を設定
          child.x = absoluteX;
          child.y = absoluteY;
        } else {
          // 位置情報がない要素もとりあえず移動
          if (parentNode && 'appendChild' in parentNode) {
            (parentNode as BaseNode & ChildrenMixin).appendChild(child);
          }
        }
      }
    }

    // 一時ノードを安全に削除
    try {
      if (!node.removed) {
        node.remove();
        // console.log(`一時ノード "${nodeName}" を削除し、${childrenToRestore.length}個の子要素を復元しました`);
      }
    } catch (removeError) {
      // console.warn("ノードの削除に失敗しました:", removeError);
    }

    return childrenToRestore;

  } catch (error: unknown) {
    const _errorMessage = error instanceof Error ? error.message : String(error);
    // console.error(`一時ノードのクリーンアップ中にエラーが発生しました: ${_errorMessage}`);
    // エラーが発生してもメインフローは継続
    return [];
  }
}

// 元の選択状態を復元
async function _restoreOriginalSelection(originalNodes: readonly SceneNode[]): Promise<void> {
  try {
    // 削除されていないノードのみをフィルタリング
    const validNodes = originalNodes.filter(node => !node.removed);

    if (validNodes.length > 0) {
      figma.currentPage.selection = validNodes;
      // console.log(`${validNodes.length}個のノードの選択状態を復元しました`);
    } else {
      // すべてのノードが削除されている場合は選択をクリア
      figma.currentPage.selection = [];
      // console.log("すべての元ノードが削除されているため、選択をクリアしました");
    }
  } catch (error: unknown) {
    const _errorMessage = error instanceof Error ? error.message : String(error);
    // console.error(`選択状態の復元中にエラーが発生しました: ${_errorMessage}`);
    // エラーが発生した場合は選択をクリア
    try {
      figma.currentPage.selection = [];
    } catch (clearError) {
      // console.error("選択のクリアにも失敗しました:", clearError);
    }
  }
}

// クリーンアップエラーのハンドリング
function handleCleanupError(_error: Error): void {
  // console.error("クリーンアップ処理でエラーが発生しました:", _error.message);
  // エラーをログに記録するが、メインワークフローは中断しない
  // 必要に応じて、ここでエラー報告やユーザー通知を行う
}

// グループ化とPNGエクスポートを組み合わせた関数（クリーンアップ機能付き）
async function groupAndExportToPng(selection: readonly SceneNode[]): Promise<PngExportResult> {
  let temporaryNode: GroupNode | FrameNode | undefined;
  const _originalNodes: readonly SceneNode[] = selection;
  let parentNode: BaseNode | undefined;

  try {
    // 選択要素の事前チェック（要件1.4対応）
    if (selection.length === 0) {
      return {
        success: false,
        error: "選択された要素がありません",
        metadata: {
          originalNodeCount: 0,
          exportScale: 0,
          fileSize: 0,
          dimensions: { width: 0, height: 0 }
        }
      };
    }

    // 親ノードを保存（クリーンアップ時に使用）
    if (selection.length > 0) {
      parentNode = selection[0].parent || undefined;
    }

    // まずグループ化を実行
    const groupingResult = await createGroupFromSelection(selection);

    if (!groupingResult.success || !groupingResult.groupedNode) {
      // グループ化失敗時の詳細なエラー情報を提供
      let errorMessage = groupingResult.error || "グループ化に失敗しました";

      // 一般的なグループ化失敗の原因を追加
      if (errorMessage.includes("親ノードが見つかりません")) {
        errorMessage += " 選択された要素が異なる親ノードに属している可能性があります。";
      } else if (errorMessage.includes("選択された要素がありません")) {
        errorMessage += " 要素を選択してから再度お試しください。";
      }

      return {
        success: false,
        error: errorMessage,
        metadata: {
          originalNodeCount: selection.length,
          exportScale: 0,
          fileSize: 0,
          dimensions: { width: 0, height: 0 }
        }
      };
    }

    temporaryNode = groupingResult.groupedNode;
    // originalNodes = groupingResult.originalNodes;

    // PNGエクスポートを実行（要件2.4対応）
    const exportResult = await exportToPng(temporaryNode);

    if (!exportResult.success) {
      // エクスポート失敗時もクリーンアップを試行
      try {
        if (selection.length > 1 && temporaryNode.name.includes("Temporary Export")) {
          await cleanupTemporaryNode(temporaryNode, parentNode);
        }
      } catch (cleanupError) {
        if (cleanupError instanceof Error) {
          handleCleanupError(cleanupError);
        }
      }

      // エクスポートエラーの詳細情報を追加
      let errorMessage = exportResult.error || "PNGエクスポートに失敗しました";

      if (errorMessage.includes("ノードの寸法が無効")) {
        errorMessage += " 選択された要素のサイズが0の可能性があります。";
      } else if (errorMessage.includes("エクスポートするノードが指定されていません")) {
        errorMessage += " 内部エラーが発生しました。再度お試しください。";
      }

      return {
        success: false,
        error: errorMessage,
        metadata: exportResult.metadata
      };
    }

    // エクスポート完了後、クリーンアップを実行
    try {
      // 単一要素の場合、または一時ノードが作成されていない場合はクリーンアップをスキップ
      if (selection.length > 1 && temporaryNode.name.includes("Temporary Export")) {
        const restoredNodes = await cleanupTemporaryNode(temporaryNode, parentNode);
        // 復元されたノードを選択状態に設定
        if (restoredNodes.length > 0) {
          figma.currentPage.selection = restoredNodes;
          // console.log(`${restoredNodes.length}個のノードの選択状態を復元しました`);
        }
      }
    } catch (cleanupError) {
      // クリーンアップエラーはログに記録するが、メインの結果には影響しない
      if (cleanupError instanceof Error) {
        handleCleanupError(cleanupError);
      }
      // クリーンアップエラーは成功結果に警告として追加
      // console.warn("クリーンアップ中にエラーが発生しましたが、PNGエクスポートは正常に完了しました");
    }

    // 成功した場合、グループ化されたノードの情報を含める
    if (exportResult.success) {
      exportResult.metadata.originalNodeCount = selection.length;
    }

    return exportResult;

  } catch (error: unknown) {
    // メインプロセスでエラーが発生した場合もクリーンアップを試行
    if (temporaryNode && selection.length > 1 && temporaryNode.name.includes("Temporary Export")) {
      try {
        const restoredNodes = await cleanupTemporaryNode(temporaryNode, parentNode);
        // 復元されたノードを選択状態に設定
        if (restoredNodes.length > 0) {
          figma.currentPage.selection = restoredNodes;
          // console.log(`エラー時に${restoredNodes.length}個のノードの選択状態を復元しました`);
        }
      } catch (cleanupError) {
        if (cleanupError instanceof Error) {
          handleCleanupError(cleanupError);
        }
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    // 一般的なエラーの詳細情報を追加
    let detailedError = `グループ化とPNGエクスポート中にエラーが発生しました: ${errorMessage}`;

    if (errorMessage.includes("Permission denied") || errorMessage.includes("権限")) {
      detailedError += " Figmaの権限設定を確認してください。";
    } else if (errorMessage.includes("Network") || errorMessage.includes("ネットワーク")) {
      detailedError += " ネットワーク接続を確認してください。";
    } else if (errorMessage.includes("Memory") || errorMessage.includes("メモリ")) {
      detailedError += " 選択された要素が大きすぎる可能性があります。要素数を減らして再度お試しください。";
    }

    return {
      success: false,
      error: detailedError,
      metadata: {
        originalNodeCount: selection.length,
        exportScale: 0,
        fileSize: 0,
        dimensions: { width: 0, height: 0 }
      }
    };
  }
}

// エラーハンドリング用の型定義
interface ErrorFeedback {
  type: 'selection' | 'grouping' | 'export' | 'cleanup' | 'general';
  message: string;
  details?: string;
  recoverable: boolean;
}

// エラーメッセージの生成
function createErrorFeedback(type: ErrorFeedback['type'], error: unknown, context?: string): ErrorFeedback {
  const errorMessage = error instanceof Error ? error.message : String(error);

  switch (type) {
    case 'selection':
      return {
        type: 'selection',
        message: '要素が選択されていません',
        details: 'Figmaで1つ以上の要素を選択してから再度お試しください。',
        recoverable: true
      };

    case 'grouping':
      return {
        type: 'grouping',
        message: 'グループ化に失敗しました',
        details: `選択された要素をグループ化できませんでした。${errorMessage}`,
        recoverable: true
      };

    case 'export':
      return {
        type: 'export',
        message: 'PNGエクスポートに失敗しました',
        details: `PNGデータの生成中にエラーが発生しました。${errorMessage}`,
        recoverable: true
      };

    case 'cleanup':
      return {
        type: 'cleanup',
        message: 'クリーンアップ処理でエラーが発生しました',
        details: `一時ファイルの削除中にエラーが発生しましたが、メイン処理は正常に完了しました。${errorMessage}`,
        recoverable: false
      };

    case 'general':
    default:
      return {
        type: 'general',
        message: '予期しないエラーが発生しました',
        details: context ? `${context}: ${errorMessage}` : errorMessage,
        recoverable: false
      };
  }
}

// ユーザーフィードバック送信
function sendErrorFeedback(feedback: ErrorFeedback, additionalData?: unknown): void {
  figma.ui.postMessage({
    type: "error-feedback",
    error: feedback,
    data: additionalData || null
  });
}

// UIからのメッセージ受信
figma.ui.onmessage = async (msg) => {
  if (msg.type === "init") {
    try {
      await loadSettings();
    } catch (error: unknown) {
      const feedback = createErrorFeedback('general', error, '設定の読み込み');
      sendErrorFeedback(feedback);
    }

  } else if (msg.type === "save-settings") {
    try {
      const { provider, openAiKey, geminiKey, format, htmlRules, pugRules, otherRules, sendPngData } = msg;
      await figma.clientStorage.setAsync("provider", provider);
      await figma.clientStorage.setAsync("openAiKey", openAiKey);
      await figma.clientStorage.setAsync("geminiKey", geminiKey);
      await figma.clientStorage.setAsync("format", format);
      await figma.clientStorage.setAsync("format-html", htmlRules);
      await figma.clientStorage.setAsync("format-pug", pugRules);
      await figma.clientStorage.setAsync("format-other", otherRules);
      await figma.clientStorage.setAsync("sendPngData", sendPngData);
      figma.ui.postMessage({ type: "saved" });
    } catch (error: unknown) {
      const feedback = createErrorFeedback('general', error, '設定の保存');
      sendErrorFeedback(feedback);
    }

  } else if (msg.type === "extract-content") {
    const selection = figma.currentPage.selection;

    // 要件1.4: 選択要素なしのエラーハンドリング
    if (selection.length === 0) {
      const feedback = createErrorFeedback('selection', new Error('No elements selected'));
      figma.ui.postMessage({
        type: "extraction-result",
        data: null,
        error: feedback.message,
        errorDetails: feedback.details,
        pngData: null
      });
      return;
    }

    try {
      // 選択されたノードの有効性を事前チェック
      const validNodes = selection.filter(node => {
        try {
          // ノードが削除されていないかチェック
          if (node.removed) {
            console.warn(`Node ${node.id} has been removed`);
            return false;
          }
          // ノード名にアクセスして有効性を確認
          const _ = node.name;
          return true;
        } catch (error) {
          console.warn(`Node ${node.id} is invalid:`, error);
          return false;
        }
      });

      if (validNodes.length === 0) {
        const feedback = createErrorFeedback('selection', new Error('All selected nodes are invalid or have been removed'));
        figma.ui.postMessage({
          type: "extraction-result",
          data: null,
          error: feedback.message,
          errorDetails: feedback.details,
          pngData: null
        });
        return;
      }

      // テキスト抽出（エラーハンドリング強化）
      let flattened: TextContent[] = [];
      try {
        const contentPromises = validNodes.map(node => extractTextContent(node.id));
        const contents = await Promise.all(contentPromises);
        flattened = contents.flat().filter(Boolean);
      } catch (textError: unknown) {
        console.warn('テキスト抽出中にエラーが発生しましたが、処理を続行します:', textError);
        // テキスト抽出エラーは警告として扱い、処理を継続
      }

      // PNG エクスポート（要件2.4: エクスポート失敗時のエラーハンドリング）
      const pngResult = await groupAndExportToPng(validNodes);

      if (!pngResult.success) {
        let feedback: ErrorFeedback;

        // エラーの種類に応じて適切なフィードバックを生成
        if (pngResult.error?.includes('選択された要素がありません')) {
          feedback = createErrorFeedback('selection', new Error(pngResult.error));
        } else if (pngResult.error?.includes('グループ化')) {
          feedback = createErrorFeedback('grouping', new Error(pngResult.error));
        } else if (pngResult.error?.includes('PNGエクスポート') || pngResult.error?.includes('エクスポート')) {
          feedback = createErrorFeedback('export', new Error(pngResult.error));
        } else {
          feedback = createErrorFeedback('general', new Error(pngResult.error || 'Unknown error'), 'PNGエクスポート処理');
        }

        figma.ui.postMessage({
          type: "extraction-result",
          data: flattened,
          error: feedback.message,
          errorDetails: feedback.details,
          errorType: feedback.type,
          recoverable: feedback.recoverable,
          pngData: null
        });
        return;
      }

      // 成功時のレスポンス
      figma.ui.postMessage({
        type: "extraction-result",
        data: flattened,
        pngData: pngResult.pngData,
        metadata: pngResult.metadata,
        success: true
      });

    } catch (error: unknown) {
      const feedback = createErrorFeedback('general', error, '抽出処理');
      figma.ui.postMessage({
        type: "extraction-result",
        data: null,
        error: feedback.message,
        errorDetails: feedback.details,
        errorType: feedback.type,
        recoverable: feedback.recoverable,
        pngData: null
      });
    }
  }
};
