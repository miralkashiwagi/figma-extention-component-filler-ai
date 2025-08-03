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
  sendSimplifiedSvg: boolean;
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
  const sendSimplifiedSvg = (await figma.clientStorage.getAsync('sendSimplifiedSvg'));
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
      sendSimplifiedSvg: sendSimplifiedSvg === undefined ? true : sendSimplifiedSvg 
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

// テキストコンテンツの抽出
async function extractTextContent(nodeId: string): Promise<TextContent[]> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return [];

  // 再帰的にテキストを抽出
  async function extractTextsFromNode(node: BaseNode): Promise<TextContent[]> {
    let texts: TextContent[] = [];

    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      // テキスト全体の範囲で使われている全フォントを取得してロード
      // const length = textNode.characters.length;
      // const fonts = new Set<string>();
      // for (let i = 0; i < length; i++) {
      //   const font = textNode.getRangeFontName(i, i + 1) as FontName;
      //   fonts.add(JSON.stringify(font));
      // }
      // // フォントを一括ロード
      // await Promise.all(Array.from(fonts).map(async (f) => {
      //   try {
      //     await figma.loadFontAsync(JSON.parse(f));
      //   } catch (error) {
      //     console.warn("Failed to load font:", JSON.parse(f), error);
      //   }
      // }));

      texts.push({
        id: textNode.id,
        text: textNode.characters
            .replace(/\u2028/g, '\n')        // Unicode改行
            .replace(/\\n/g, '\n')           // バックスラッシュn → 改行
            .replace(/\r\n/g, '\n')          // CRLF → LF
            .replace(/\r/g, '\n')            // CR → LF
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
    const { provider, openAiKey, geminiKey, format, htmlRules, pugRules, otherRules, sendSimplifiedSvg } = msg;
    await figma.clientStorage.setAsync("provider", provider);
    await figma.clientStorage.setAsync("openAiKey", openAiKey);
    await figma.clientStorage.setAsync("geminiKey", geminiKey);
    await figma.clientStorage.setAsync("format", format);
    await figma.clientStorage.setAsync("format-html", htmlRules);
    await figma.clientStorage.setAsync("format-pug", pugRules);
    await figma.clientStorage.setAsync("format-other", otherRules);
    await figma.clientStorage.setAsync("sendSimplifiedSvg", sendSimplifiedSvg);
    figma.ui.postMessage({ type: "saved" });

  } else if (msg.type === "extract-content") {
    const includeSvg = msg.includeSvg !== undefined ? msg.includeSvg : true;
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
      if (includeSvg && selection.length > 0) {
        try {
          const bytes = await (selection[0] as SceneNode & ExportMixin).exportAsync({
            format: "SVG",
            svgOutlineText: false
          });
          svgData = String.fromCharCode(...bytes);
        } catch (e) {
          svgData = "";
        }
      } else {
        svgData = "";
      }

      figma.ui.postMessage({
        type: "extraction-result",
        data: flattened,
        svgData
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      figma.ui.postMessage({
        type: "extraction-result",
        data: null,
        error: `抽出中にエラーが発生しました: ${errorMessage}`
      });
    }
  }
};
