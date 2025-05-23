"use strict";
// code.ts
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// プラグインのメイン処理
figma.showUI(__html__, { width: 480, height: 600 });
// クライアントストレージから設定を読み込む
function loadSettings() {
    return __awaiter(this, void 0, void 0, function* () {
        const provider = (yield figma.clientStorage.getAsync('provider')) || 'openai';
        const openAiKey = (yield figma.clientStorage.getAsync('openAiKey')) || '';
        const geminiKey = (yield figma.clientStorage.getAsync('geminiKey')) || '';
        const format = (yield figma.clientStorage.getAsync('format')) || 'html';
        const htmlRules = (yield figma.clientStorage.getAsync('format-html')) || '';
        const pugRules = (yield figma.clientStorage.getAsync('format-pug')) || '';
        const otherRules = (yield figma.clientStorage.getAsync('format-other')) || '';
        const sendSimplifiedSvg = (yield figma.clientStorage.getAsync('sendSimplifiedSvg'));
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
            }
        });
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
function extractTextContent(nodeId) {
    return __awaiter(this, void 0, void 0, function* () {
        const node = yield figma.getNodeByIdAsync(nodeId);
        if (!node)
            return [];
        // 再帰的にテキストを抽出
        function extractTextsFromNode(node) {
            return __awaiter(this, void 0, void 0, function* () {
                let texts = [];
                if (node.type === "TEXT") {
                    const textNode = node;
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
                            .replace(/\u2028/g, '\n') // Unicode改行
                            .replace(/\\n/g, '\n') // バックスラッシュn → 改行
                            .replace(/\r\n/g, '\n') // CRLF → LF
                            .replace(/\r/g, '\n') // CR → LF
                        // style: {
                        //   fontSize: textNode.fontSize,
                        //   fontWeight: textNode.fontWeight,
                        //   textCase: textNode.textCase
                        // }
                    });
                }
                else if ("children" in node) {
                    for (const child of node.children) {
                        texts = texts.concat(yield extractTextsFromNode(child));
                    }
                }
                return texts;
            });
        }
        return extractTextsFromNode(node);
    });
}
// UIからのメッセージ受信
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    if (msg.type === "init") {
        yield loadSettings();
    }
    else if (msg.type === "save-settings") {
        const { provider, openAiKey, geminiKey, format, htmlRules, pugRules, otherRules, sendSimplifiedSvg } = msg;
        yield figma.clientStorage.setAsync("provider", provider);
        yield figma.clientStorage.setAsync("openAiKey", openAiKey);
        yield figma.clientStorage.setAsync("geminiKey", geminiKey);
        yield figma.clientStorage.setAsync("format", format);
        yield figma.clientStorage.setAsync("format-html", htmlRules);
        yield figma.clientStorage.setAsync("format-pug", pugRules);
        yield figma.clientStorage.setAsync("format-other", otherRules);
        yield figma.clientStorage.setAsync("sendSimplifiedSvg", sendSimplifiedSvg);
        figma.ui.postMessage({ type: "saved" });
    }
    else if (msg.type === "extract-content") {
        const includeSvg = msg.includeSvg !== undefined ? msg.includeSvg : true;
        const selection = figma.currentPage.selection;
        if (selection.length === 0) {
            figma.ui.postMessage({ type: "extraction-result", data: null, error: "フレームが選択されていません" });
            return;
        }
        try {
            // テキスト抽出
            const contentPromises = selection.map(node => extractTextContent(node.id));
            const contents = yield Promise.all(contentPromises);
            const flattened = contents.flat().filter(Boolean);
            // SVG 抽出（オプション）
            let svgData = "";
            if (includeSvg && selection.length > 0) {
                try {
                    const bytes = yield selection[0].exportAsync({
                        format: "SVG",
                        svgOutlineText: false
                    });
                    svgData = String.fromCharCode(...bytes);
                }
                catch (e) {
                    svgData = "";
                }
            }
            else {
                svgData = "";
            }
            figma.ui.postMessage({
                type: "extraction-result",
                data: flattened,
                svgData
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            figma.ui.postMessage({
                type: "extraction-result",
                data: null,
                error: `抽出中にエラーが発生しました: ${errorMessage}`
            });
        }
    }
});
