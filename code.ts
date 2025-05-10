// code.ts

// プラグインのメイン処理
figma.showUI(__html__, { width: 480, height: 600 });

// クライアントストレージから設定を読み込む
async function loadSettings() {
  const provider = await figma.clientStorage.getAsync('provider') || 'openai';
  const openAiKey = await figma.clientStorage.getAsync('openAiKey') || '';
  const geminiKey = await figma.clientStorage.getAsync('geminiKey') || '';
  const format = await figma.clientStorage.getAsync('format') || 'html';
  const htmlRules = await figma.clientStorage.getAsync('format-html') || '';
  const pugRules = await figma.clientStorage.getAsync('format-pug') || '';
  const otherRules = await figma.clientStorage.getAsync('format-other') || '';

  figma.ui.postMessage({
    type: "load-settings",
    data: { provider, openAiKey, geminiKey, format, htmlRules, pugRules, otherRules }
  });
}

// 選択要素の変更を監視し、UIへ送信
figma.on("selectionchange", () => {
  const selection = figma.currentPage.selection;
  const data = selection.map(node => ({
    id: node.id,
    name: node.name,
    type: node.type
  }));
  figma.ui.postMessage({ type: "selection", data });
});

// テキストコンテンツの抽出
async function extractTextContent(nodeId: string): Promise<any[]> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return [];

  // 再帰的にテキストを抽出
  async function extractTextsFromNode(node: BaseNode): Promise<any[]> {
    let texts: any[] = [];

    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      // テキスト全体の範囲で使われている全フォントを取得してロード
      const length = textNode.characters.length;
      const fonts = new Set<string>();
      for (let i = 0; i < length; i++) {
        const font = textNode.getRangeFontName(i, i + 1) as FontName;
        fonts.add(JSON.stringify(font));
      }
      // フォントを一括ロード
      await Promise.all(Array.from(fonts).map(f => figma.loadFontAsync(JSON.parse(f))));

      texts.push({
        id: textNode.id,
        text: textNode.characters.replace(/\u2028/g, '\n'),
        // style: {
        //   fontSize: textNode.fontSize,
        //   fontWeight: textNode.fontWeight,
        //   textCase: textNode.textCase
        // }
      });
    } else if ("children" in node) {
      for (const child of node.children) {
        texts = texts.concat(await extractTextsFromNode(child));
      }
    }

    return texts;
  }

  return extractTextsFromNode(node);
}

// UIからのメッセージ受信
figma.ui.onmessage = async (msg) => {
  if (msg.type === "init") {
    await loadSettings();

  } else if (msg.type === "save-settings") {
    const { provider, openAiKey, geminiKey, format, htmlRules, pugRules, otherRules } = msg;
    await figma.clientStorage.setAsync("provider", provider);
    await figma.clientStorage.setAsync("openAiKey", openAiKey);
    await figma.clientStorage.setAsync("geminiKey", geminiKey);
    await figma.clientStorage.setAsync("format", format);
    await figma.clientStorage.setAsync("format-html", htmlRules);
    await figma.clientStorage.setAsync("format-pug", pugRules);
    await figma.clientStorage.setAsync("format-other", otherRules);
    figma.ui.postMessage({ type: "saved" });

  } else if (msg.type === "extract-content") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "extraction-result", data: null, error: "フレームが選択されていません" });
      return;
    }

    try {
      // テキスト抽出
      const contentPromises = selection.map(node => extractTextContent(node.id));
      const contents = await Promise.all(contentPromises);
      const flattened = contents.flat().filter(Boolean);

      // SVG 抽出（オプション）
      let svgData = "";
      if (msg.includeSvg) {
        const svgPromises = selection.map(async node => {
          // ExportMixin を持つノードのみ SVG 出力可能
          if ("exportAsync" in node) {
            const bytes = await (node as SceneNode & ExportMixin).exportAsync({
              format: "SVG",
              svgOutlineText: false
            });
            return Array.from(bytes).map(b => String.fromCharCode(b)).join("");
          }
          return "";
        });
        const svgResults = await Promise.all(svgPromises);
        svgData = svgResults.filter(s => s).join("\n");
      }

      figma.ui.postMessage({
        type: "extraction-result",
        data: flattened,
        svgData
      });

    } catch (error: any) {
      figma.ui.postMessage({
        type: "extraction-result",
        data: null,
        error: `抽出中にエラーが発生しました: ${error.message}`
      });
    }
  }
};
