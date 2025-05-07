// code.ts

// プラグインのメイン処理
figma.showUI(__html__, { width: 480, height: 700 });

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
async function extractTextContent(nodeId:string) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return null;
  
  // 再帰的にテキストコンテンツを抽出する関数
async function extractTextsFromNode(node:BaseNode): Promise<any[]> {
  let texts: any[] = [];
  
  if (node.type === "TEXT") {
    // テキストノードからテキストを取得
    await figma.loadFontAsync(node.fontName as FontName);
    texts.push({
      id: node.id,
      name: node.name,
      text: node.characters,
      style: {
        fontSize: node.fontSize,
        fontWeight: node.fontWeight,
        textCase: node.textCase
      }
    });
  } else if ("children" in node) {
    // 子ノードがある場合は再帰的に処理
    for (const child of node.children) {
      const childTexts = await extractTextsFromNode(child);
      texts = [...texts, ...childTexts];
    }
  }
  
  return texts;
}
  
  return await extractTextsFromNode(node);
}

// UIからのメッセージ受信
figma.ui.onmessage = async (msg) => {
  if (msg.type === "init") {
    // 初期設定読み込み
    await loadSettings();
  } else if (msg.type === "save-settings") {
    // 設定保存: APIキー、フォーマット、追加ルール
    const { provider, openAiKey, geminiKey, format, htmlRules, pugRules, otherRules } = msg;
    await figma.clientStorage.setAsync("provider", provider);
    await figma.clientStorage.setAsync("openAiKey", openAiKey);
    await figma.clientStorage.setAsync("geminiKey", geminiKey);
    await figma.clientStorage.setAsync("format", format);
    await figma.clientStorage.setAsync("format-html", htmlRules);
    await figma.clientStorage.setAsync("format-pug", pugRules);
    await figma.clientStorage.setAsync("format-other", otherRules);
    // 保存完了をUIへ通知
    figma.ui.postMessage({ type: "saved" });
  } else if (msg.type === "extract-content") {
    // 選択されたノードからテキストコンテンツを抽出
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "extraction-result", data: null, error: "フレームが選択されていません" });
      return;
    }
    
    try {
      const contentPromises = selection.map(node => extractTextContent(node.id));
      const contents = await Promise.all(contentPromises);
      figma.ui.postMessage({ 
        type: "extraction-result", 
        data: contents.flat().filter(Boolean)
      });
    } catch (error:any) {
      figma.ui.postMessage({ 
        type: "extraction-result", 
        data: null, 
        error: `抽出中にエラーが発生しました: ${error.message}` 
      });
    }
  }
};